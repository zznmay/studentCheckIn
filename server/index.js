'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const store = require('./store');
const api = require('./api');
const { json } = require('./utils');

store.init();
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

function serveFile(req, res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const stat = fs.statSync(filePath);
  // 协商缓存：内容未变化返回 304，减少移动端重复下载
  const etag = `W/"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    return res.end();
  }
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    ETag: etag,
    Vary: 'Accept-Encoding',
  };
  let body = fs.readFileSync(filePath);
  // 文本类资源启用 gzip（>1KB 时才值得压缩）
  if (COMPRESSIBLE.has(ext) && body.length > 1024 && String(req.headers['accept-encoding'] || '').includes('gzip')) {
    headers['Content-Encoding'] = 'gzip';
    body = zlib.gzipSync(body);
  }
  res.writeHead(200, headers);
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  let pathname = '/';
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    pathname = decodeURIComponent(u.pathname);
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
  console.log('  默认管理员: admin / admin123（登录后请尽快在「账号管理」中修改密码）');
  console.log('');
});
