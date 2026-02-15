import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const DIST_DIR = resolve(process.cwd(), 'dist');
const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);

if (!existsSync(DIST_DIR)) {
  console.error('dist folder not found. Run `npm run build` first.');
  process.exit(1);
}

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp'
};

function toSafePath(pathname) {
  const normalized = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = resolve(join(DIST_DIR, normalized));
  if (!filePath.startsWith(DIST_DIR)) return null;
  return filePath;
}

function sendFile(res, filePath) {
  const ext = extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  createReadStream(filePath).pipe(res);
}

const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }

  const requestUrl = new URL(req.url || '/', 'http://localhost');
  let pathname = decodeURIComponent(requestUrl.pathname);
  if (pathname === '/') pathname = '/index.html';

  const filePath = toSafePath(pathname);
  if (!filePath) {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  if (existsSync(filePath) && statSync(filePath).isFile()) {
    sendFile(res, filePath);
    return;
  }

  if (!extname(pathname)) {
    sendFile(res, join(DIST_DIR, 'index.html'));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, HOST, () => {
  console.log(`WreckSpace server listening on ${HOST}:${PORT}`);
});
