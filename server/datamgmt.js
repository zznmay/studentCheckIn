'use strict';
// ==================== 数据管理（备份 / 恢复 / 迁移 / 灰测留存） ====================
// 零依赖实现。统一「数据包（Bundle）」逻辑格式：
// { kind, label, schemaVersion, appVersion, exportedAt, source, counts, collections, manifest, attachments }
// manifest 内逐集合记录 count + sha256，导入侧必须复核，任一不符拒绝落盘。
// 修改80：schemaVersion 1 → 2 —— 集合内不再内嵌 base64 图片（改为内容寻址引用），
// 数据包落盘为 zip 容器：bundle.json（集合+引用+附件清单）+ attachments/<sha256>（附件树）。
// zip 自包含 → 迁移到新服务器时附件随包落盘；v1 旧包（内嵌 base64 的纯 JSON）仍可导入，
// 导入时自动转换为引用（见 resolveBundle / applyBundle）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const store = require('./store');
const attachments = require('./attachments');
const { zipStore, zipRead } = require('./xlsx');
const { json, readBody, nowISO, uid } = require('./utils');

const DATA_DIR = path.join(__dirname, '..', 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups'); // 服务端快照（自动保留 30 份）
const ARCHIVE_DIR = path.join(DATA_DIR, 'archives'); // 灰测归档（只增不删）
const AUTO_DIR = path.join(DATA_DIR, 'auto-backups'); // 定时自动备份（保留 N 份）
// 修改79：分片上传暂存区（大数据包专用，见 /api/data/restore/upload）
const UPLOAD_DIR = path.join(DATA_DIR, 'tmp-uploads');
const OPLOG_FILE = path.join(DATA_DIR, 'oplog.json');
const SCHEMA_VERSION = 2;
const APP_VERSION = '2.1';
const KEEP_BACKUPS = 30;
// 数组型集合（恢复时整体替换）；settings 为对象、staffs 为数组，均参与备份
// 修改72：classes 为后增集合（班级管理），必须登记否则不进备份包
// 修改81：attendanceLogs（考勤修改日志）同为后增集合，必须登记否则不进备份包
const ARRAY_KEYS = ['users', 'students', 'attendance', 'leaves', 'tokens', 'staffs', 'appeals', 'punishments', 'classes', 'attendanceLogs'];
const ALL_KEYS = [...ARRAY_KEYS, 'settings'];
// 修改27：appeals 为后增集合——旧数据包不含此键时宽松降级为空数组，保证历史灾备包仍可导入
// 修改30：punishments 同为后增集合，纳入宽松降级（历史灾备包不含此键时恢复为空数组）
// 修改72：classes 同理（历史灾备包不含此键时恢复为空数组，不阻断导入）
// 修改81：attendanceLogs 同理
const LENIENT_KEYS = ['appeals', 'punishments', 'classes', 'attendanceLogs'];

for (const d of [BACKUP_DIR, ARCHIVE_DIR, AUTO_DIR, UPLOAD_DIR]) fs.mkdirSync(d, { recursive: true });

// ---------- 基础工具 ----------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const clone = (x) => JSON.parse(JSON.stringify(x));

function oplog(user, action, detail) {
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(OPLOG_FILE, 'utf8'));
    if (!Array.isArray(list)) list = [];
  } catch {
    list = [];
  }
  list.unshift({ at: nowISO(), user: user ? `${user.name}(${user.username})` : 'system', action, detail: String(detail || '').slice(0, 300) });
  fs.writeFileSync(OPLOG_FILE, JSON.stringify(list.slice(0, 500), null, 2), 'utf8');
}

// ---------- 数据包（Bundle） ----------
/** 扫描集合里被引用的附件 sha256（修改80）：只收实际被引用的，不打包 data/attachments 全目录 */
function collectAttachmentRefs(collections) {
  const refs = new Map(); // sha256 -> {sha256, mime, size}
  const add = (ref) => {
    if (!ref || !/^[0-9a-f]{64}$/.test(String(ref.sha256 || ''))) return;
    const sha = String(ref.sha256);
    if (refs.has(sha)) return;
    let size = Number(ref.size);
    if (!Number.isFinite(size)) {
      try {
        size = fs.statSync(attachments.fileOf(sha)).size;
      } catch {
        size = 0;
      }
    }
    refs.set(sha, { sha256: sha, mime: String(ref.mime || 'image/png'), size });
  };
  for (const s of collections.attendance || []) {
    if (s && s.signatureRef) add(s.signatureRef);
    if (s && typeof s.signature === 'string' && s.signature.startsWith('data:')) add({ sha256: sha256(s.signature) });
  }
  for (const a of collections.appeals || []) {
    for (const x of (a && a.attachments) || []) {
      if (x && x.sha256) add(x);
      else if (x && typeof x.dataUrl === 'string' && x.dataUrl.startsWith('data:')) add({ sha256: sha256(x.dataUrl) });
    }
  }
  return Object.fromEntries(refs);
}

function makeBundle(kind, label, source) {
  const collections = {};
  for (const k of ARRAY_KEYS) collections[k] = clone(store.db[k] || []);
  collections.settings = clone(store.db.settings || {});
  const manifest = {};
  for (const k of ALL_KEYS) manifest[k] = { count: Array.isArray(collections[k]) ? collections[k].length : 1, sha256: sha256(JSON.stringify(collections[k])) };
  return {
    kind: kind || 'backup',
    label: label || '',
    schemaVersion: SCHEMA_VERSION,
    appVersion: APP_VERSION,
    exportedAt: nowISO(),
    source: source || 'unknown',
    counts: Object.fromEntries(ALL_KEYS.map((k) => [k, manifest[k].count])),
    collections,
    manifest,
    attachments: collectAttachmentRefs(collections), // 修改80：附件清单（sha256 → {size, mime}）
  };
}

/** 修改80：bundle → zip 字节流（bundle.json + attachments/<sha256>）
 *  容错：个别附件文件缺失时不抛错——跳过该附件并在 bundle.attachmentsMissing 标记。
 *  否则「记录引用在、文件丢了」的损坏态会让备份/快照整体失败（无法备份、无法自愈）。
 *  注意这只影响**导出**：导入侧 verifyBundle 仍要求 attMap 中附件齐全，缺一即拒绝落盘。 */
function buildBundleZip(bundle) {
  const files = [{ name: 'bundle.json', data: Buffer.from(JSON.stringify(bundle, null, 2), 'utf8') }];
  const missing = [];
  for (const [sha] of Object.entries(bundle.attachments || {})) {
    const f = attachments.fileOf(sha);
    if (!fs.existsSync(f)) {
      missing.push(sha);
      continue;
    }
    files.push({ name: `attachments/${sha}`, data: fs.readFileSync(f) });
  }
  if (missing.length) {
    bundle.attachmentsMissing = missing;
    console.warn(`[datamgmt] ${missing.length} 个附件文件缺失，已跳过打包：${missing.map((s) => `${s.slice(0, 8)}…`).join(' ')}`);
  }
  return zipStore(files);
}

/** 修改80：读取数据包文件 → { bundle, attMap }；.zip 走 zipRead，.json 为 v1 旧包（无附件） */
function loadBundleFile(file) {
  if (!/\.zip$/i.test(file)) {
    return { bundle: JSON.parse(fs.readFileSync(file, 'utf8')), attMap: null };
  }
  const entries = zipRead(fs.readFileSync(file));
  const bj = entries['bundle.json'];
  if (!bj) throw new Error('数据包缺少 bundle.json（不是有效的备份包）');
  const attMap = new Map();
  for (const [name, buf] of Object.entries(entries)) {
    if (name.startsWith('attachments/') && name.length > 'attachments/'.length) attMap.set(name.slice('attachments/'.length), buf);
  }
  return { bundle: JSON.parse(bj.toString('utf8')), attMap };
}

/** 校验数据包完整性与清单一致性，返回 { ok, checks }
 *  修改80：schemaVersion 1/2 双接受；v2 且带附件清单时逐个核对附件 sha256 + 字节数
 *  （zipRead 不校验 CRC，这里补强校验：缺附件或内容不符一律拒绝） */
function verifyBundle(bundle, attMap) {
  const checks = [];
  let ok = true;
  if (!bundle || typeof bundle !== 'object' || !bundle.collections || !bundle.manifest) {
    return { ok: false, checks: [{ key: 'bundle', ok: false, message: '数据包格式不正确' }] };
  }
  for (const k of ALL_KEYS) {
    if (bundle.collections[k] === undefined) {
      if (LENIENT_KEYS.includes(k)) {
        checks.push({ key: k, ok: true, message: '数据包不含考勤异议数据（旧版数据包，恢复时按空处理）' });
        continue;
      }
      checks.push({ key: k, ok: false, message: '缺少集合' });
      ok = false;
      continue;
    }
    const cnt = Array.isArray(bundle.collections[k]) ? bundle.collections[k].length : 1;
    const sum = sha256(JSON.stringify(bundle.collections[k]));
    const m = bundle.manifest[k] || {};
    const okKey = cnt === m.count && sum === m.sha256;
    checks.push({ key: k, ok: okKey, message: okKey ? '校验通过' : '清单不符（内容或条数与导出时不一致）' });
    if (!okKey) ok = false;
  }
  // 修改80：附件清单校验（v1 旧包无 attachments 键 → 跳过，导入时按内嵌形态自动转换）
  const attList = bundle.attachments && typeof bundle.attachments === 'object' ? Object.entries(bundle.attachments) : [];
  if (attList.length) {
    let bad = 0;
    for (const [sha, info] of attList) {
      const buf = attMap && attMap.get(sha);
      if (!buf) {
        bad += 1;
        continue;
      }
      if (attachments.sha256Buf(buf) !== sha || (info && info.size != null && buf.length !== info.size)) bad += 1;
    }
    const total = attList.length;
    checks.push({ key: 'attachments', ok: bad === 0, message: bad === 0 ? `校验通过（${total} 个附件）` : `${bad}/${total} 个附件缺失或内容不符` });
    if (bad) ok = false;
  }
  return { ok, checks };
}

function saveBundle(bundle, dir) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const id = `${bundle.kind === 'migration' ? 'migration' : bundle.kind === 'archive' ? 'gray-archive' : bundle.kind === 'auto-backup' ? 'auto' : 'snap'}-${ts}-${uid('x').slice(-4)}`;
  // 修改80：数据包落盘为 zip（bundle.json + attachments/），保证迁移自包含
  const file = path.join(dir, `${id}.zip`);
  fs.writeFileSync(file, buildBundleZip(bundle));
  const meta = {
    id,
    kind: bundle.kind,
    label: bundle.label || '',
    exportedAt: bundle.exportedAt,
    source: bundle.source,
    counts: bundle.counts,
    schemaVersion: bundle.schemaVersion || 1,
    attachmentCount: Object.keys(bundle.attachments || {}).length, // 修改80：附件个数（列表展示用）
    attachmentsMissing: (bundle.attachmentsMissing || []).length, // 导出时发现的文件缺失数（>0 说明该环境附件不完整）
    size: fs.statSync(file).size, // zip 文件字节数
    dir: path.basename(dir),
    file: path.basename(file),
  };
  fs.writeFileSync(path.join(dir, `${id}.meta.json`), JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

function listBundles() {
  const out = [];
  for (const dir of [BACKUP_DIR, ARCHIVE_DIR, AUTO_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.meta.json')) continue;
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      } catch {
        /* 跳过损坏的 meta */
      }
    }
  }
  return out.sort((a, b) => String(b.exportedAt).localeCompare(String(a.exportedAt)));
}

function findBundle(id) {
  for (const dir of [BACKUP_DIR, ARCHIVE_DIR, AUTO_DIR]) {
    // 修改80：先找 zip（v2 新包），再回落 json（v1 旧包，历史灾备仍可用）
    for (const ext of ['.zip', '.json']) {
      const f = path.join(dir, `${id}${ext}`);
      if (fs.existsSync(f)) return { file: f, dir };
    }
  }
  return null;
}

// ---------- 修改79：数据包分片上传暂存 ----------
// 背景：部署平台网关对单次请求体约 ≥2MB 的 POST 会直接掐断 TLS 连接（curl 表现为
// sslv3 alert bad record mac / connection reset），整体上传的数据包永远到不了业务层。
// 对策：前端先切片、逐片上传（单片 ≤512KB），服务端拼装成完整 JSON 后以 uploadId 索引，
// 后续预检 / 恢复只传 uploadId（几十字节），彻底绕开请求体上限。
const UPLOAD_MAX_TOTAL = 256 * 1024 * 1024; // 单个数据包拼装后上限（字节）
const UPLOAD_TTL_MS = 2 * 60 * 60 * 1000; // 分片与成品保留时长：2 小时
const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

function safeUploadId(id) {
  const s = String(id == null ? '' : id);
  return UPLOAD_ID_RE.test(s) ? s : '';
}

function findUpload(id) {
  const safe = safeUploadId(id);
  if (!safe) return null;
  const f = path.join(UPLOAD_DIR, `${safe}.json`);
  return fs.existsSync(f) ? f : null;
}

function purgeStaleUploads() {
  if (!fs.existsSync(UPLOAD_DIR)) return;
  const now = Date.now();
  for (const name of fs.readdirSync(UPLOAD_DIR)) {
    let st;
    try {
      st = fs.statSync(path.join(UPLOAD_DIR, name));
    } catch {
      continue; // 文件恰被其他进程清理
    }
    if (now - st.mtimeMs < UPLOAD_TTL_MS) continue;
    try {
      fs.rmSync(path.join(UPLOAD_DIR, name), { recursive: true, force: true });
    } catch {
      /* 清理失败不影响主流程 */
    }
  }
}

function pruneBackups() {
  const metas = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.meta.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, f), 'utf8')))
    .sort((a, b) => String(b.exportedAt).localeCompare(String(a.exportedAt)));
  for (const m of metas.slice(KEEP_BACKUPS)) {
    for (const suffix of ['.json', '.zip', '.meta.json']) { // 修改80：zip 为新包格式，json 为历史 v1 包
      const f = path.join(BACKUP_DIR, `${m.id}${suffix}`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  }
}

/** 恢复应用：整体替换各集合并落盘（调用方须已完成校验并做过恢复前快照）
 *  修改80：① 附件先落盘合并进 data/attachments（内容寻址天然去重）；
 *         ② v1 旧包（内嵌 base64）统一在此转换为引用 —— 三条导入路径的唯一收口点 */
function applyBundle(bundle, attMap) {
  for (const [sha, buf] of attMap || new Map()) {
    if (!attachments.has(sha)) {
      const info = (bundle.attachments || {})[sha] || {};
      attachments.putBuffer(buf, info.mime || 'image/png');
    }
  }
  attachments.externalizeCollections(bundle.collections); // v1 内嵌 → 引用（幂等；失败项保留原样）
  for (const k of ARRAY_KEYS) {
    store.db[k] = bundle.collections[k] || [];
    store.save(k);
  }
  store.db.settings = bundle.collections.settings || { periodTimes: store.DEFAULT_PERIOD_TIMES };
  store.save('settings');
  scheduleAuto();
}

// ---------- 定时自动备份 ----------
const AUTO_INTERVALS = [1, 2, 4, 6, 12, 24]; // 允许的间隔（小时）

function autoCfg() {
  const c = (store.db.settings && store.db.settings.autoBackup) || {};
  return {
    enabled: !!c.enabled,
    intervalHours: AUTO_INTERVALS.includes(Number(c.intervalHours)) ? Number(c.intervalHours) : 24,
    keep: Math.min(30, Math.max(3, Number(c.keep) || 10)),
    lastRunAt: c.lastRunAt || '',
    lastSignature: c.lastSignature || '',
    lastBundleId: c.lastBundleId || '',
  };
}

let autoTimer = null;
function nextRunAt() {
  const cfg = autoCfg();
  if (!cfg.enabled) return '';
  if (!cfg.lastRunAt) return new Date(Date.now() + 30 * 1000).toISOString(); // 与首跑调度一致
  const intervalMs = cfg.intervalHours * 3600 * 1000;
  const elapsed = Date.now() - new Date(cfg.lastRunAt).getTime();
  return new Date(Math.max(Date.now() + 30 * 1000, Date.now() + intervalMs - Math.max(0, elapsed))).toISOString();
}

function autoMetas() {
  return fs
    .readdirSync(AUTO_DIR)
    .filter((f) => f.endsWith('.meta.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(AUTO_DIR, f), 'utf8')))
    .sort((a, b) => String(b.exportedAt).localeCompare(String(a.exportedAt)));
}

function scheduleAuto() {
  if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
  const cfg = autoCfg();
  if (!cfg.enabled) return;
  const intervalMs = cfg.intervalHours * 3600 * 1000;
  const elapsed = cfg.lastRunAt ? Date.now() - new Date(cfg.lastRunAt).getTime() : 0;
  // 首次开启（尚无 lastRunAt）30 秒内先备份一份；之后按间隔执行，过期则尽快补跑
  const delay = cfg.lastRunAt ? Math.max(30 * 1000, intervalMs - Math.max(0, elapsed)) : 30 * 1000;
  autoTimer = setTimeout(() => {
    try { runAutoBackup(false); } catch (e) { console.error('[auto-backup]', e.message); scheduleAuto(); }
  }, delay);
  if (autoTimer.unref) autoTimer.unref();
}

/** 执行一次自动备份：内容签名未变化则跳过写入，仅刷新 lastRunAt（force=true 时强制写包） */
function runAutoBackup(force) {
  try {
    const cfg = autoCfg();
    if (!cfg.enabled && !force) return null;
    const bundle = makeBundle('auto-backup', `自动备份 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, 'auto-scheduler');
    // 签名排除 settings.autoBackup（其内含 lastSignature 自引用，否则每次必不一致）
    const settingsForSig = { ...(bundle.collections.settings || {}) };
    delete settingsForSig.autoBackup;
    const sig = sha256(ALL_KEYS.map((k) => JSON.stringify(k === 'settings' ? settingsForSig : bundle.collections[k])).join('|'));
    let meta = null;
    if (force || sig !== cfg.lastSignature) {
      meta = saveBundle(bundle, AUTO_DIR);
      const metas = autoMetas();
      for (const m of metas.slice(cfg.keep)) {
        for (const sfx of ['.json', '.meta.json']) {
          const f = path.join(AUTO_DIR, `${m.id}${sfx}`);
          if (fs.existsSync(f)) fs.unlinkSync(f);
        }
      }
    }
    store.db.settings = { ...(store.db.settings || {}), autoBackup: { ...cfg, lastRunAt: nowISO(), lastSignature: sig, lastBundleId: meta ? meta.id : cfg.lastBundleId } };
    store.save('settings');
    oplog(null, '自动备份', meta ? `${meta.id}（${meta.size} 字节）` : '数据无变化，跳过写入');
    return meta;
  } finally {
    scheduleAuto();
  }
}

// ---------- 路由注册 ----------
function register({ route, fail }) {
  const admin = { roles: ['admin'] };

  // 总览：各集合条数 / 体积 / 最后写入 + 备份归档概况 + 灰测窗口
  route('GET', '/api/data/overview', admin, async ({ res, user }) => {
    const keys = ALL_KEYS;
    const collections = keys.map((k) => {
      const f = path.join(DATA_DIR, `${k}.json`);
      let bytes = 0;
      let mtime = '';
      try {
        const st = fs.statSync(f);
        bytes = st.size;
        mtime = st.mtime.toISOString();
      } catch {
        /* 文件尚不存在 */
      }
const count = Array.isArray(store.db[k]) ? store.db[k].length : store.db[k] ? 1 : 0;
    return { key: k, count, bytes, mtime };
  });
    // 修改80：附件（签名 / 异议佐证材料）已外置为内容寻址文件，单列一行便于迁移后核对是否齐备
    const attStat = attachments.attachmentStats();
    collections.push({ key: 'attachments', count: attStat.count, bytes: attStat.bytes, mtime: '' });
    const bundles = listBundles();
    const backups = bundles.filter((b) => b.dir === 'backups');
    const archives = bundles.filter((b) => b.dir === 'archives');
    const autos = bundles.filter((b) => b.dir === 'auto-backups');
    let oplogList = [];
    try {
      oplogList = JSON.parse(fs.readFileSync(OPLOG_FILE, 'utf8')).slice(0, 8);
    } catch {
      /* 空 */
    }
    json(res, 200, {
      collections,
      grayWindow: (store.db.settings && store.db.settings.grayWindow) || null,
      backupCount: backups.length,
      lastBackup: backups[0] || null,
      archiveCount: archives.length,
      lastArchive: archives[0] || null,
      autoBackup: { config: autoCfg(), count: autos.length, last: autos[0] || null, nextRunAt: nextRunAt() },
      oplog: oplogList,
      by: user.name,
    });
  });

  // 创建备份 / 生成迁移包（数据包立即下载即得迁移包）
  route('POST', '/api/data/backup', admin, async ({ res, user, body }) => {
    const kind = body.kind === 'migration' ? 'migration' : 'backup';
    const label = String(body.label || '').trim().slice(0, 50);
    const meta = saveBundle(makeBundle(kind, label, 'workbuddy-sites'), BACKUP_DIR);
    pruneBackups();
    oplog(user, kind === 'migration' ? '生成迁移包' : '创建备份', `${meta.id}（${meta.size} 字节）`);
    json(res, 200, { meta });
  });

  // 数据包列表
  route('GET', '/api/data/bundles', admin, async ({ res }) => {
    json(res, 200, { list: listBundles() });
  });

  // 下载数据包（离机保存 / 带往新服务器）
  route('GET', '/api/data/bundles/:id/download', admin, async ({ res, params, user }) => {
    const hit = findBundle(params.id);
    if (!hit) fail(404, '数据包不存在或已被清理');
    const body = fs.readFileSync(hit.file);
    oplog(user, '下载数据包', params.id);
    // 修改80：按实际后缀决定类型与文件名（.zip 新包自包含附件；.json 为历史 v1 包）
    const ext = /\.zip$/i.test(hit.file) ? '.zip' : '.json';
    res.writeHead(200, {
      'Content-Type': ext === '.zip' ? 'application/zip' : 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${params.id}${ext}"; filename*=UTF-8''${encodeURIComponent(params.id + ext)}`,
    });
    res.end(body);
  });

  // 修改79：分片上传数据包（大包专用通道；单片上限由前端控制在 512KB 以内）
  route('POST', '/api/data/restore/upload', admin, async ({ res, body }) => {
    purgeStaleUploads();
    const uploadId = safeUploadId(body.uploadId);
    if (!uploadId) fail(400, 'uploadId 不合法');
    const total = Number(body.total);
    const index = Number(body.index);
    if (!Number.isInteger(total) || total < 1 || total > 4000) fail(400, '分片总数不合法');
    if (!Number.isInteger(index) || index < 0 || index >= total) fail(400, '分片序号不合法');
    const chunk = body.chunk;
    if (typeof chunk !== 'string' || !chunk) fail(400, '分片内容为空');
    const chunkBytes = Buffer.byteLength(chunk, 'utf8');
    if (chunkBytes > 2 * 1024 * 1024) fail(413, '单片体积过大，请缩小分片后重试');

    const dir = path.join(UPLOAD_DIR, uploadId);
    fs.mkdirSync(dir, { recursive: true });
    let sum = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.part')) continue;
      try {
        sum += fs.statSync(path.join(dir, f)).size;
      } catch {
        /* 忽略并发清理 */
      }
    }
    if (sum + chunkBytes > UPLOAD_MAX_TOTAL) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 清理失败忽略 */
      }
      fail(413, `数据包超过 ${Math.round(UPLOAD_MAX_TOTAL / 1024 / 1024)}MB 上限，已终止本次上传`);
    }
    fs.writeFileSync(path.join(dir, `${String(index).padStart(6, '0')}.part`), chunk, 'utf8');

    const parts = fs.readdirSync(dir).filter((f) => f.endsWith('.part')).sort();
    if (parts.length < total) return json(res, 200, { ok: true, done: false, received: parts.length, total });

    // 全部到齐：按序号拼接 → 解析校验 → 落成品，前端随后用 uploadId 走预检 / 恢复
    const text = parts.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
    let bundle;
    try {
      bundle = JSON.parse(text);
    } catch (e) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 清理失败忽略 */
      }
      fail(400, `数据包拼接后无法解析（${e.message}），请重新导出后重试`);
    }
    fs.writeFileSync(path.join(UPLOAD_DIR, `${uploadId}.json`), JSON.stringify(bundle), 'utf8');
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败忽略 */
    }
    json(res, 200, { ok: true, done: true, bytes: Buffer.byteLength(text, 'utf8') });
  });

  // 修改79/80：预检与恢复统一入口 —— bundle（内联小包）/ id（服务端已有包）/ uploadId（分片上传）
  // 返回 { bundle, attMap }：attMap 为 zip 包携带的附件表（sha256 → Buffer），v1 旧包为 null
  function resolveBundle(body) {
    if (body.bundle && typeof body.bundle === 'object') return { bundle: body.bundle, attMap: null };
    if (body.id) {
      const hit = findBundle(String(body.id));
      if (!hit) fail(404, '数据包不存在或已被清理');
      try {
        return loadBundleFile(hit.file);
      } catch (e) {
        fail(400, `数据包读取失败：${e.message}`);
      }
    }
    if (body.uploadId) {
      const f = findUpload(body.uploadId);
      if (!f) fail(404, '上传的数据包不存在或已过期（超过 2 小时），请重新选择文件');
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    }
    fail(400, '缺少数据包（bundle / id / uploadId）');
  }

  // 恢复预检：校验数据包 + 与当前数据条数对比（不落盘）
  route('POST', '/api/data/restore/preview', admin, async ({ res, body }) => {
    const { bundle, attMap } = resolveBundle(body);
    const { ok, checks } = verifyBundle(bundle, attMap);
    const diff = ALL_KEYS.map((k) => {
      const cur = Array.isArray(store.db[k]) ? store.db[k].length : store.db[k] ? 1 : 0;
      const inc = Array.isArray(bundle.collections[k]) ? bundle.collections[k].length : 1;
      return { key: k, current: cur, incoming: inc };
    });
    // 修改80：附件文件计数（信息性展示，不参与 ok 判定；校验由 checks 里的 attachments 项承担）
    const attStat = attachments.attachmentStats();
    diff.push({ key: 'attachments', current: attStat.count, incoming: Object.keys(bundle.attachments || {}).length });
    json(res, 200, { ok, checks, diff, bundleMeta: { kind: bundle.kind, label: bundle.label, exportedAt: bundle.exportedAt, appVersion: bundle.appVersion, source: bundle.source, schemaVersion: bundle.schemaVersion || 1 } });
  });

  // 恢复：需确认短语；恢复前自动做 pre-restore 快照（可回滚）
  route('POST', '/api/data/restore', admin, async ({ res, user, body }) => {
    if (String(body.confirm || '').trim() !== '恢复') fail(400, '请输入确认短语「恢复」以执行该操作');
    const { bundle, attMap } = resolveBundle(body);
    const { ok, checks } = verifyBundle(bundle, attMap);
    if (!ok) fail(400, `数据包校验未通过：${checks.filter((c) => !c.ok).map((c) => `${c.key}(${c.message})`).join('；')}`);
    const pre = saveBundle(makeBundle('backup', '恢复前自动快照', 'workbuddy-sites'), BACKUP_DIR);
    pruneBackups();
    applyBundle(bundle, attMap);
    // 修改79：恢复成功后释放分片上传的临时成品（可按 uploadId 重传，无需保留）
    try {
      const f = findUpload(body.uploadId);
      if (f) fs.unlinkSync(f);
    } catch {
      /* 清理失败不影响恢复结果 */
    }
    oplog(user, '恢复数据', `来源包 ${bundle.kind}:${bundle.exportedAt}；恢复前快照 ${pre.id}`);
    json(res, 200, { ok: true, preSnapshot: pre.id, counts: bundle.counts });
  });

  // 灰测窗口配置
  route('POST', '/api/data/gray/window', admin, async ({ res, user, body }) => {
    const start = String(body.start || '').trim();
    const end = String(body.end || '').trim();
    const label = String(body.label || '').trim().slice(0, 30) || '灰测';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) fail(400, '请选择有效的开始 / 结束日期');
    if (start > end) fail(400, '开始日期不能晚于结束日期');
    store.db.settings = { ...(store.db.settings || {}), grayWindow: { start, end, label } };
    store.save('settings');
    oplog(user, '设置灰测窗口', `${label}：${start} ~ ${end}`);
    json(res, 200, { grayWindow: store.db.settings.grayWindow });
  });

  // 灰测概况（窗口内 createdAt 判定；未配置窗口时返回提示）
  route('GET', '/api/data/gray/summary', admin, async ({ res }) => {
    const w = store.db.settings && store.db.settings.grayWindow;
    if (!w) return json(res, 200, { grayWindow: null, summary: null });
    const inWin = (t) => String(t || '').slice(0, 10) >= w.start && String(t || '').slice(0, 10) <= w.end;
    json(res, 200, {
      grayWindow: w,
      summary: {
        attendance: store.db.attendance.filter((s) => inWin(s.createdAt)).length,
        leaves: store.db.leaves.filter((l) => inWin(l.importedAt || l.createdAt)).length,
        students: store.db.students.filter((s) => inWin(s.createdAt)).length,
      },
    });
  });

  // 灰测数据只读查询（考勤 / 假单）
  route('GET', '/api/data/gray/query', admin, async ({ res, query }) => {
    const w = store.db.settings && store.db.settings.grayWindow;
    if (!w) fail(400, '请先配置灰测时间窗口');
    const type = query.type === 'leaves' ? 'leaves' : 'attendance';
    const className = (query.className || '').trim();
    const status = (query.status || '').trim();
    let list = [];
    if (type === 'attendance') {
      list = store.db.attendance
        .filter((s) => String(s.createdAt).slice(0, 10) >= w.start && String(s.createdAt).slice(0, 10) <= w.end)
        .filter((s) => !className || s.className === className)
        .map((s) => ({
          id: s.id, className: s.className, date: s.date, periods: s.periods, courseName: s.courseName, teacher: s.teacher,
          counts: s.items.reduce((a, it) => ((a[it.status] = (a[it.status] || 0) + 1), a), {}),
          createdBy: s.createdBy, createdAt: s.createdAt, confirmStatus: s.confirmStatus,
        }));
      if (status) list = list.filter((s) => (s.counts[status] || 0) > 0);
    } else {
      list = store.db.leaves
        .filter((l) => String(l.importedAt || l.createdAt || '').slice(0, 10) >= w.start && String(l.importedAt || l.createdAt || '').slice(0, 10) <= w.end)
        .filter((l) => !className || l.className === className)
        .filter((l) => !status || l.status === status)
        .map((l) => ({ id: l.id, studentName: l.studentName, studentId: l.studentId, className: l.className, type: l.type, startDate: l.startDate, endDate: l.endDate, status: l.status, reason: l.reason }));
    }
    list.sort((a, b) => String(b.createdAt || b.startDate || '').localeCompare(String(a.createdAt || a.startDate || '')));
    json(res, 200, { total: list.length, list: list.slice(0, 200) });
  });

  // 灰测归档留底：生成主库完整快照存入 archives（只增不删），主库数据不受影响
  route('POST', '/api/data/gray/archive', admin, async ({ res, user, body }) => {
    const w = store.db.settings && store.db.settings.grayWindow;
    const label = w ? `${w.label}-${w.start}至${w.end}` : String(body.label || '').trim() || '灰测留底';
    const meta = saveBundle(makeBundle('archive', label, 'workbuddy-sites'), ARCHIVE_DIR);
    oplog(user, '灰测归档留底', `${meta.id}（${label}）`);
    json(res, 200, { meta });
  });

  // ---------- 定时自动备份 ----------
  // 状态查询
  route('GET', '/api/data/autobackup', admin, async ({ res }) => {
    const metas = autoMetas();
    json(res, 200, { config: autoCfg(), nextRunAt: nextRunAt(), count: metas.length, last: metas[0] || null, intervals: AUTO_INTERVALS });
  });

  // 保存配置（开启/关闭、间隔、保留份数）
  route('POST', '/api/data/autobackup', admin, async ({ res, user, body }) => {
    const enabled = !!body.enabled;
    const intervalHours = AUTO_INTERVALS.includes(Number(body.intervalHours)) ? Number(body.intervalHours) : 24;
    const keep = Math.min(30, Math.max(3, Number(body.keep) || 10));
    const prev = autoCfg();
    store.db.settings = { ...(store.db.settings || {}), autoBackup: { ...prev, enabled, intervalHours, keep } };
    store.save('settings');
    oplog(user, enabled ? '开启自动备份' : '关闭自动备份', `间隔 ${intervalHours} 小时，保留 ${keep} 份`);
    scheduleAuto();
    json(res, 200, { config: autoCfg(), nextRunAt: nextRunAt() });
  });

  // 立即执行一次（force：无视签名去重强制写包）
  route('POST', '/api/data/autobackup/run', admin, async ({ res, user }) => {
    const meta = runAutoBackup(true);
    oplog(user, '手动触发自动备份', meta ? meta.id : '数据无变化');
    json(res, 200, { meta });
  });

  // 操作日志
  route('GET', '/api/data/oplog', admin, async ({ res }) => {
    let list = [];
    try {
      list = JSON.parse(fs.readFileSync(OPLOG_FILE, 'utf8'));
    } catch {
      /* 空 */
    }
    json(res, 200, { total: list.length, list: list.slice(0, 100) });
  });
}

scheduleAuto();

/** 修改80：供启动迁移调用——改动存量数据（附件外置）前先打一份完整快照，可整体回滚到旧版本代码 */
function snapshot(label) {
  const meta = saveBundle(makeBundle('backup', label, 'auto-migrate'), BACKUP_DIR);
  pruneBackups();
  return meta;
}

module.exports = { register, makeBundle, verifyBundle, applyBundle, oplog, runAutoBackup, snapshot };
