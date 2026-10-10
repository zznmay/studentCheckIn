'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const store = require('./store');
const api = require('./api');
const { json } = require('./utils');

store.init();
// 修改80：启动时把存量内嵌 base64 附件（点名签名 / 异议佐证材料）外置为内容寻址文件（幂等）
api.externalizeAllAttachments();
// 修改30：启动时回溯补算历史存量缺勤的处分（幂等，已一致的学生零写盘）
api.backfillAllPunishments();

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 3000;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.csv': 'text/csv; charset=utf-8',
  '.woff2': 'font/woff2',
};

const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg', '.csv']);

// 修改78（缓存根治）：构建号。每次进程启动生成（可用 BUILD_ID 环境变量固定），
// 注入 index.html 的资源链接与 <meta name="build-id">，使每次发版后 HTML 引用的
// css/js URL 必然变化；配合下面的 no-store，彻底消除「手机端仍是旧版本」。
const BUILD_ID = process.env.BUILD_ID
  || new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const BUILD_QUERY = `v=${BUILD_ID}`;

/** 给 index.html 注入版本参数与构建号（幂等：已带 v= 参数时不重复追加） */
function injectBuild(html) {
  return html
    .replace(/(href=")(css\/app\.css)(")/, (_m, a, b, c) => `${a}${b}?${BUILD_QUERY}${c}`)
    .replace(/(src=")(js\/app\.js)(")/, (_m, a, b, c) => `${a}${b}?${BUILD_QUERY}${c}`)
    .replace(/(<head>)/, `$1\n  <meta name="build-id" content="${BUILD_ID}" />`);
}

/**
 * 修改78：静态资源一律 no-store（原 no-cache 允许浏览器缓存后 revalidate，
 * iOS Safari bfcache 与微信 X5 WebView 会直接复用本地副本不发请求，导致发版后
 * 手机端长期停留在旧版）。ETag 由「size+mtime」弱校验改为内容 md5 强校验，
 * 杜绝「内容变了但校验器没变」的 304 误判。
 */
function serveFile(req, res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let body = fs.readFileSync(filePath);
  if (ext === '.html') body = Buffer.from(injectBuild(body.toString('utf8')), 'utf8');
  const etag = `"${crypto.createHash('md5').update(body).digest('hex')}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-store, must-revalidate' });
    return res.end();
  }
  // 图片等二进制资源内容稳定，允许短时缓存；文本类一律 no-store 保证即时生效
  const cacheControl = COMPRESSIBLE.has(ext)
    ? 'no-store, must-revalidate'
    : 'public, max-age=3600';
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': cacheControl,
    ETag: etag,
    Vary: 'Accept-Encoding',
  };
  if (COMPRESSIBLE.has(ext) && body.length > 1024 && String(req.headers['accept-encoding'] || '').includes('gzip')) {
    headers['Content-Encoding'] = 'gzip';
    body = zlib.gzipSync(body);
  }
  res.writeHead(200, headers);
  res.end(body);
}

/** 修改78：免登录健康检查 / 数据探针（仅返回条数，不含任何业务明细，用于发版后校验数据未被重置） */
function health(res) {
  const db = store.db;
  const count = (v) => (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0);
  json(res, 200, {
    ok: true,
    buildId: BUILD_ID,
    counts: {
      users: count(db.users),
      students: count(db.students),
      attendance: count(db.attendance),
      leaves: count(db.leaves),
      appeals: count(db.appeals),
      punishments: count(db.punishments),
      staffs: count(db.staffs),
      classes: count(db.classes),
    },
  });
}

const server = http.createServer(async (req, res) => {
  let pathname = '/';
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    pathname = decodeURIComponent(u.pathname);
    if (pathname === '/api/health') return health(res);
    if (pathname.startsWith('/api/')) return await api.handle(req, res, pathname, u.searchParams);
  } catch (e) {
    return json(res, e.status || 400, { message: e.message || '请求解析失败' });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 404, { message: 'Not Found' });
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) return json(res, 403, { message: 'Forbidden' });
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return serveFile(req, res, filePath);
  // SPA：非静态资源路径回退到 index.html
  if (!path.extname(pathname)) return serveFile(req, res, path.join(PUBLIC_DIR, 'index.html'));
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  学生考勤工作台 已启动');
  console.log(`  访问地址: http://localhost:${PORT}`);
  console.log(`  构建号: ${BUILD_ID}（移动端缓存校验用：/api/health 或页面 <meta name="build-id">）`);
  console.log('  默认管理员: admin / admin123（登录后请尽快在「账号管理」中修改密码）');
  console.log('');
});
