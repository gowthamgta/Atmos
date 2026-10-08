// Lightweight Production Build Preview Server with IMD Radar Reverse Proxy
// Runs on Node.js without third-party dependencies

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const DIST_DIR = path.resolve(__dirname, '../dist/weather-platform/browser');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.webp': 'image/webp',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // 1. IMD Doppler Radar Proxy endpoint
  if (pathname.startsWith('/imd-radar/')) {
    const filename = pathname.replace('/imd-radar/', '');
    if (filename.includes('..') || !/^[a-zA-Z0-9_\-./]+\.(gif|png|jpg|jpeg)$/i.test(filename)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid radar file' }));
    }
    const targetUrl = `https://mausam.imd.gov.in/Radar/${filename}`;

    const proxyReq = https.request(
      targetUrl,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          Referer: 'https://mausam.imd.gov.in/'
        }
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode, {
          'Content-Type': proxyRes.headers['content-type'] || 'image/gif',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=60'
        });
        proxyRes.pipe(res);
      }
    );

    proxyReq.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });

    return proxyReq.end();
  }

  // 2. Static File Serving
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Bad Request');
  }
  let filePath = path.join(DIST_DIR, decodedPath);
  // Never serve files outside the build output directory
  if (filePath !== DIST_DIR && !filePath.startsWith(DIST_DIR + path.sep)) {
    filePath = path.join(DIST_DIR, 'index.html');
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    const indexFallback = path.join(DIST_DIR, 'index.html');
    if (fs.existsSync(indexFallback)) {
      filePath = indexFallback;
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n🚀 Weather Platform Preview Server running at: http://localhost:${PORT}/`);
  console.log(`📡 IMD Radar Proxy active at: http://localhost:${PORT}/imd-radar/\n`);
});
