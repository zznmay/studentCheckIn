'use strict';
// ==================== 修改80：附件外置（内容寻址落盘 + dataUri ↔ 引用编解码 + 存量迁移） ====================
// 背景：点名确认签名（attendance.signature，约 59KB/次）与考勤异议佐证材料
// （appeals[].attachments，单张 dataUrl ≤1.4MB）此前以 base64 内嵌在集合 JSON 中，
// 导致备份包体积随点名次数线性膨胀（且 base64 几乎不可压缩）。
// 方案：图片按内容寻址落盘到 data/attachments/<sha256>，记录里只存 {sha256, mime, size} 引用；
// 对外响应仍在读取点回填为 data URI —— **接口响应形状与改造前完全一致，前端渲染零改动**。
//
// 关键设计：
// - 原子幂等落盘：tmp 文件 + renameSync；sha256 相同即内容相同，文件已存在则跳过（天然去重）。
// - 双读兼容：读取层同时接受新引用（signatureRef / {sha256,...}）与旧内嵌字段，
//   因此「迁移中途崩溃」的半迁移状态也能正常显示。
// - 失败不阻塞：单条转换失败保留原样并计数，下次启动自动重试。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ATTACH_DIR = path.join(DATA_DIR, 'attachments');
fs.mkdirSync(ATTACH_DIR, { recursive: true });

// mime 白名单：与既有校验（confirm 前缀 data:image/png、parseAttachments 的 jpeg|png|webp）一致
const MIME_WHITELIST = new Set(['image/png', 'image/jpeg', 'image/webp']);
const DATA_URI_RE = /^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/;
const SHA_RE = /^[0-9a-f]{64}$/;
// 解码后体积上限（防御性）：调用方已在解码前按原始 dataUrl 长度限流，这里兜底 base64 膨胀
const MAX_BYTES = 8 * 1024 * 1024;

const sha256Buf = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const fileOf = (sha) => path.join(ATTACH_DIR, String(sha));
const isSha = (s) => typeof s === 'string' && SHA_RE.test(s);

/** dataUrl → { mime, buf }；格式非法 / mime 不在白名单 / 解码失败返回 null */
function parseDataUri(dataUrl) {
  const m = DATA_URI_RE.exec(String(dataUrl || ''));
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (!MIME_WHITELIST.has(mime)) return null;
  const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  if (!buf.length || buf.length > MAX_BYTES) return null;
  return { mime, buf };
}

/** 落盘（原子 + 幂等）并返回引用 { sha256, mime, size }；已存在同内容则直接复用 */
function putBuffer(buf, mime) {
  const sha256 = sha256Buf(buf);
  const file = fileOf(sha256);
  if (!fs.existsSync(file)) {
    const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file); // 同分区内 rename 原子：不会出现「记录指向半个文件」
  }
  return { sha256, mime: MIME_WHITELIST.has(mime) ? mime : 'image/png', size: buf.length };
}

/** dataUrl 便捷入口：解析 + 落盘；非法返回 null */
function putDataUri(dataUrl) {
  const parsed = parseDataUri(dataUrl);
  if (!parsed) return null;
  return putBuffer(parsed.buf, parsed.mime);
}

const has = (sha) => isSha(sha) && fs.existsSync(fileOf(sha));

/** 引用 → data URI；引用无效或文件已丢失返回 ''（读侧降级，不抛错） */
function toDataUri(ref) {
  const sha = ref && (ref.sha256 || ref);
  if (!isSha(sha)) return '';
  try {
    const buf = fs.readFileSync(fileOf(sha));
    const mime = (ref && ref.mime) || 'image/png';
    return `data:${MIME_WHITELIST.has(mime) ? mime : 'image/png'};base64,${buf.toString('base64')}`;
  } catch {
    return ''; // 文件缺失：调用方渲染占位，不影响其余数据
  }
}

/** 考勤记录出参：signatureRef → signature（dataUri），删除引用字段，形状与改造前一致 */
function hydrateAttendance(s) {
  if (!s || typeof s !== 'object') return s;
  if (!s.signatureRef) return s;
  const out = { ...s, signature: toDataUri(s.signatureRef) };
  delete out.signatureRef;
  return out;
}

/** 异议单出参：附件引用元素 → { name, dataUrl }，形状与改造前一致（同时兼容旧内嵌形态） */
function hydrateAppeal(a) {
  if (!a || typeof a !== 'object' || !Array.isArray(a.attachments)) return a;
  return {
    ...a,
    attachments: a.attachments.map((x) => {
      if (!x || typeof x !== 'object') return x;
      if (x.dataUrl) return x;
      return { name: x.name, dataUrl: toDataUri(x) };
    }),
  };
}

/**
 * 就地转换集合中的内嵌 base64 为引用（幂等）。三条导入路径（内联包 / 服务端包 / 分片上传）
 * 与启动迁移共用此函数，是「旧格式包自动转换」的唯一收口点。
 * @returns {{changed:number, failed:number}}
 */
function externalizeCollections(collections) {
  let changed = 0;
  let failed = 0;
  for (const s of collections.attendance || []) {
    if (!s || typeof s.signature !== 'string' || !s.signature.startsWith('data:')) continue;
    try {
      const ref = putDataUri(s.signature);
      if (!ref) throw new Error('签名 dataUrl 格式非法');
      s.signatureRef = ref;
      delete s.signature;
      changed += 1;
    } catch {
      failed += 1; // 保留原样，下次启动/下次导入重试
    }
  }
  for (const a of collections.appeals || []) {
    if (!a || !Array.isArray(a.attachments)) continue;
    let touched = false;
    const next = [];
    for (const x of a.attachments) {
      if (!x || typeof x !== 'object' || !x.dataUrl) {
        next.push(x);
        continue;
      }
      try {
        const ref = putDataUri(x.dataUrl);
        if (!ref) throw new Error('附件 dataUrl 格式非法');
        next.push({ name: x.name, sha256: ref.sha256, mime: ref.mime, size: ref.size });
        touched = true;
        changed += 1;
      } catch {
        failed += 1;
        next.push(x); // 转换失败保留原始内嵌形态，读取侧仍能显示
      }
    }
    if (touched) a.attachments = next;
  }
  return { changed, failed };
}

/** 是否存在待外置的内嵌数据（用于判断要不要打迁移前快照） */
function hasInlineData(collections) {
  const att = (collections.attendance || []).some((s) => s && typeof s.signature === 'string' && s.signature.startsWith('data:'));
  const apl = (collections.appeals || []).some((a) => a && Array.isArray(a.attachments) && a.attachments.some((x) => x && x.dataUrl));
  return att || apl;
}

/**
 * 启动迁移：把存量内嵌 base64 一次性外置（仿 backfillAllPunishments 范式：幂等 + touched 才落盘）。
 * @param {object} deps
 * @param {object} deps.store   store 模块
 * @param {Function} [deps.snapshot] 迁移前快照回调（有存量内嵌数据时才调用）
 */
function externalizeAllAttachments({ store, snapshot } = {}) {
  const t0 = Date.now();
  if (!store || !store.db) return { changed: 0, failed: 0, skipped: true };
  if (!hasInlineData(store.db)) {
    console.log('[attachments] 启动迁移：无需外置（数据已是引用形态）');
    return { changed: 0, failed: 0 };
  }
  if (typeof snapshot === 'function') {
    try {
      snapshot();
    } catch (e) {
      console.error('[attachments] 迁移前快照失败，仍继续外置：', e.message);
    }
  }
  const { changed, failed } = externalizeCollections(store.db);
  if (changed > 0) {
    store.save('attendance');
    store.save('appeals');
  }
  console.log(
    `[attachments] 启动迁移完成：外置 ${changed} 项，失败 ${failed} 项（${Date.now() - t0}ms${failed ? '，失败项保留原样将在下次启动重试' : ''}）`
  );
  return { changed, failed };
}

/** 统计当前附件目录文件数与总字节（数据总览用，便于迁移后核对附件是否齐备） */
function attachmentStats() {
  let count = 0;
  let bytes = 0;
  try {
    for (const f of fs.readdirSync(ATTACH_DIR)) {
      if (!SHA_RE.test(f)) continue; // 忽略 tmp 残留等非内容寻址文件
      count += 1;
      try {
        bytes += fs.statSync(path.join(ATTACH_DIR, f)).size;
      } catch {
        /* 并发清理忽略 */
      }
    }
  } catch {
    /* 目录不存在忽略 */
  }
  return { count, bytes };
}

module.exports = {
  ATTACH_DIR,
  MIME_WHITELIST,
  sha256Buf,
  parseDataUri,
  putBuffer,
  putDataUri,
  toDataUri,
  has,
  fileOf,
  hydrateAttendance,
  hydrateAppeal,
  externalizeCollections,
  hasInlineData,
  externalizeAllAttachments,
  attachmentStats,
};