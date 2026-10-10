'use strict';
// ==================== 数据管理（备份 / 恢复 / 迁移 / 灰测留存） ====================
// 零依赖实现。统一「数据包（Bundle）」格式：
// { kind, label, schemaVersion, appVersion, exportedAt, source, counts, collections, manifest }
// manifest 内逐集合记录 count + sha256，导入侧必须复核，任一不符拒绝落盘。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const store = require('./store');
const { json, readBody, nowISO, uid } = require('./utils');

const DATA_DIR = path.join(__dirname, '..', 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups'); // 服务端快照（自动保留 30 份）
const ARCHIVE_DIR = path.join(DATA_DIR, 'archives'); // 灰测归档（只增不删）
const AUTO_DIR = path.join(DATA_DIR, 'auto-backups'); // 定时自动备份（保留 N 份）
// 修改79：分片上传暂存区（大数据包专用，见 /api/data/restore/upload）
const UPLOAD_DIR = path.join(DATA_DIR, 'tmp-uploads');
const OPLOG_FILE = path.join(DATA_DIR, 'oplog.json');
const SCHEMA_VERSION = 1;
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
  };
}

/** 校验数据包完整性与清单一致性，返回 { ok, checks } */
function verifyBundle(bundle) {
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
  return { ok, checks };
}

function saveBundle(bundle, dir) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const id = `${bundle.kind === 'migration' ? 'migration' : bundle.kind === 'archive' ? 'gray-archive' : bundle.kind === 'auto-backup' ? 'auto' : 'snap'}-${ts}-${uid('x').slice(-4)}`;
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(bundle, null, 2), 'utf8');
  const meta = {
    id,
    kind: bundle.kind,
    label: bundle.label || '',
    exportedAt: bundle.exportedAt,
    source: bundle.source,
    counts: bundle.counts,
    size: fs.statSync(file).size,
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
    const f = path.join(dir, `${id}.json`);
    if (fs.existsSync(f)) return { file: f, dir };
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
    for (const suffix of ['.json', '.meta.json']) {
      const f = path.join(BACKUP_DIR, `${m.id}${suffix}`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  }
}

/** 恢复应用：整体替换各集合并落盘（调用方须已完成校验并做过恢复前快照） */
function applyBundle(bundle) {
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
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${params.id}.json"; filename*=UTF-8''${encodeURIComponent(params.id + '.json')}`,
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

  // 修改79：预检与恢复统一入口 —— bundle（内联小包）/ id（服务端已有包）/ uploadId（分片上传）
  function resolveBundle(body) {
    if (body.bundle && typeof body.bundle === 'object') return body.bundle;
    if (body.id) {
      const hit = findBundle(String(body.id));
      if (!hit) fail(404, '数据包不存在或已被清理');
      return JSON.parse(fs.readFileSync(hit.file, 'utf8'));
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
    const bundle = resolveBundle(body);
    const { ok, checks } = verifyBundle(bundle);
    const diff = ALL_KEYS.map((k) => {
      const cur = Array.isArray(store.db[k]) ? store.db[k].length : store.db[k] ? 1 : 0;
      const inc = Array.isArray(bundle.collections[k]) ? bundle.collections[k].length : 1;
      return { key: k, current: cur, incoming: inc };
    });
    json(res, 200, { ok, checks, diff, bundleMeta: { kind: bundle.kind, label: bundle.label, exportedAt: bundle.exportedAt, appVersion: bundle.appVersion, source: bundle.source } });
  });

  // 恢复：需确认短语；恢复前自动做 pre-restore 快照（可回滚）
  route('POST', '/api/data/restore', admin, async ({ res, user, body }) => {
    if (String(body.confirm || '').trim() !== '恢复') fail(400, '请输入确认短语「恢复」以执行该操作');
    const bundle = resolveBundle(body);
    const { ok, checks } = verifyBundle(bundle);
    if (!ok) fail(400, `数据包校验未通过：${checks.filter((c) => !c.ok).map((c) => `${c.key}(${c.message})`).join('；')}`);
    const pre = saveBundle(makeBundle('backup', '恢复前自动快照', 'workbuddy-sites'), BACKUP_DIR);
    pruneBackups();
    applyBundle(bundle);
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
