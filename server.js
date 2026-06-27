'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const BACKEND_URL = new URL(
  process.env.BACKEND_URL || 'https://backend-production-9036.up.railway.app'
);
const CACHE_DIR = process.env.VIDEO_CACHE_DIR || path.join(os.tmpdir(), 'flowtok-v2-video-cache');
const MAX_CACHE_BYTES = Number(process.env.MAX_CACHE_BYTES || 512 * 1024 * 1024);
const MAX_VIDEO_BYTES = Number(process.env.MAX_VIDEO_BYTES || 256 * 1024 * 1024);
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 180_000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const downloadJobs = new Map();
const videoMeta = new Map();

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function safeFileId(value) {
  const fileId = String(value || '').trim();
  if (!fileId || fileId.length > 220 || !/^[A-Za-z0-9_-]+$/.test(fileId)) return '';
  return fileId;
}

function cacheKey(fileId) {
  return crypto.createHash('sha256').update(fileId).digest('hex');
}

function cachePaths(fileId) {
  const key = cacheKey(fileId);
  return {
    file: path.join(CACHE_DIR, `${key}.mp4`),
    temp: path.join(CACHE_DIR, `${key}.${process.pid}.part`),
    meta: path.join(CACHE_DIR, `${key}.json`),
  };
}

function upstreamRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'http:' ? http : https;
    const request = transport.request(url, options, resolve);

    request.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      request.destroy(new Error('Backend timeout'));
    });

    request.once('error', reject);
    if (options.body) request.end(options.body);
    else request.end();
  });
}

async function requestWithRedirects(url, options = {}, redirects = 0) {
  const response = await upstreamRequest(url, options);
  const status = response.statusCode || 0;

  if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
    response.resume();
    if (redirects >= 5) throw new Error('Terlalu banyak redirect dari backend');
    const next = new URL(response.headers.location, url);
    return requestWithRedirects(next, options, redirects + 1);
  }

  return response;
}

async function readSmallBody(stream, limit = 32 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > limit) break;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8').slice(0, limit);
}

async function trimCache(excludeFile = '') {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  const entries = await fsp.readdir(CACHE_DIR, { withFileTypes: true }).catch(() => []);
  const files = [];
  let total = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.mp4')) continue;
    const fullPath = path.join(CACHE_DIR, entry.name);
    const stat = await fsp.stat(fullPath).catch(() => null);
    if (!stat) continue;
    total += stat.size;
    files.push({ path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
  }

  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const item of files) {
    if (total <= MAX_CACHE_BYTES) break;
    if (item.path === excludeFile) continue;
    await fsp.rm(item.path, { force: true }).catch(() => {});
    await fsp.rm(item.path.replace(/\.mp4$/, '.json'), { force: true }).catch(() => {});
    total -= item.size;
  }
}

async function downloadVideo(fileId) {
  const paths = cachePaths(fileId);
  const existing = await fsp.stat(paths.file).catch(() => null);
  if (existing?.isFile() && existing.size > 0) {
    await fsp.utimes(paths.file, new Date(), new Date()).catch(() => {});
    return { path: paths.file, size: existing.size, contentType: 'video/mp4' };
  }

  if (downloadJobs.has(fileId)) return downloadJobs.get(fileId);

  const job = (async () => {
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    await fsp.rm(paths.temp, { force: true }).catch(() => {});

    const target = new URL(`/api/stream/${encodeURIComponent(fileId)}`, BACKEND_URL);
    const response = await requestWithRedirects(target, {
      method: 'GET',
      headers: {
        Accept: 'video/mp4,video/*;q=0.9,*/*;q=0.8',
        'User-Agent': 'FlowTok-Frontend-Proxy/2.2',
        Connection: 'close',
      },
    });

    const status = response.statusCode || 0;
    if (status < 200 || status >= 300) {
      const detail = await readSmallBody(response);
      throw new Error(`Backend stream gagal (${status})${detail ? `: ${detail}` : ''}`);
    }

    const declaredLength = Number(response.headers['content-length'] || 0);
    if (declaredLength > MAX_VIDEO_BYTES) {
      response.destroy();
      throw new Error('Ukuran video melebihi batas proxy');
    }

    let received = 0;
    response.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_VIDEO_BYTES) response.destroy(new Error('Ukuran video melebihi batas proxy'));
    });

    try {
      await pipeline(response, fs.createWriteStream(paths.temp, { flags: 'wx' }));
      const stat = await fsp.stat(paths.temp);
      if (!stat.size) throw new Error('Backend mengirim file video kosong');

      await fsp.rename(paths.temp, paths.file);
      const contentType = String(response.headers['content-type'] || 'video/mp4').split(';')[0];
      await fsp.writeFile(paths.meta, JSON.stringify({ fileId, contentType, size: stat.size }), 'utf8').catch(() => {});
      await trimCache(paths.file);
      return { path: paths.file, size: stat.size, contentType };
    } catch (error) {
      await fsp.rm(paths.temp, { force: true }).catch(() => {});
      throw error;
    }
  })();

  downloadJobs.set(fileId, job);
  try {
    return await job;
  } finally {
    downloadJobs.delete(fileId);
  }
}

function parseRange(rangeHeader, size) {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(rangeHeader).trim());
  if (!match) return { invalid: true };

  let start;
  let end;

  if (match[1] === '' && match[2] !== '') {
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) {
    return { invalid: true };
  }

  end = Math.min(end, size - 1);
  return { start, end };
}

async function serveVideo(req, res, fileId) {
  try {
    const cached = await downloadVideo(fileId);
    const stat = await fsp.stat(cached.path);
    const range = parseRange(req.headers.range, stat.size);

    const common = {
      'Content-Type': cached.contentType || 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    };

    if (range?.invalid) {
      res.writeHead(416, {
        ...common,
        'Content-Range': `bytes */${stat.size}`,
        'Content-Length': '0',
      });
      res.end();
      return;
    }

    if (range) {
      const length = range.end - range.start + 1;
      res.writeHead(206, {
        ...common,
        'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
        'Content-Length': String(length),
      });

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      const stream = fs.createReadStream(cached.path, { start: range.start, end: range.end });
      stream.on('error', (error) => res.destroy(error));
      stream.pipe(res);
      return;
    }

    res.writeHead(200, {
      ...common,
      'Content-Length': String(stat.size),
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(cached.path);
    stream.on('error', (error) => res.destroy(error));
    stream.pipe(res);
  } catch (error) {
    console.error('[stream-proxy]', fileId, error.message);
    if (!res.headersSent) json(res, 502, { ok: false, error: 'Video gagal diambil dari backend', detail: error.message });
    else res.destroy(error);
  }
}

function rememberVideoMetadata(payload) {
  const list = Array.isArray(payload) ? payload : (payload?.items || payload?.videos || []);
  for (const item of list) {
    const fileId = item?.fileId || item?.drive_file_id || item?.driveFileId;
    if (!fileId) continue;
    videoMeta.set(String(fileId), {
      size: Number(item?.size || item?.file_size || item?.fileSize || 0),
      contentType: item?.mimeType || 'video/mp4',
    });
  }
}

function proxyApi(req, res) {
  const target = new URL(req.url, BACKEND_URL);
  const headers = { ...req.headers, host: BACKEND_URL.host };

  delete headers.origin;
  delete headers.referer;
  delete headers.connection;
  delete headers['content-length'];

  const chunks = [];
  let bodySize = 0;

  req.on('data', (chunk) => {
    bodySize += chunk.length;
    if (bodySize <= 2 * 1024 * 1024) chunks.push(chunk);
  });

  req.on('end', async () => {
    const body = chunks.length ? Buffer.concat(chunks) : null;
    if (body) headers['content-length'] = String(body.length);

    try {
      const proxyRes = await requestWithRedirects(target, {
        method: req.method,
        headers,
        body,
      });

      const responseHeaders = { ...proxyRes.headers };
      delete responseHeaders['access-control-allow-origin'];
      delete responseHeaders['access-control-allow-credentials'];
      delete responseHeaders['content-security-policy'];
      delete responseHeaders.connection;

      const isVideoList = req.method === 'GET' && (/^\/api\/(videos|feed)(\?|$)/).test(req.url);
      if (!isVideoList) {
        res.writeHead(proxyRes.statusCode || 502, responseHeaders);
        proxyRes.pipe(res);
        return;
      }

      const buffers = [];
      for await (const chunk of proxyRes) buffers.push(chunk);
      const responseBody = Buffer.concat(buffers);
      try {
        rememberVideoMetadata(JSON.parse(responseBody.toString('utf8')));
      } catch {}

      responseHeaders['content-length'] = String(responseBody.length);
      delete responseHeaders['transfer-encoding'];
      res.writeHead(proxyRes.statusCode || 502, responseHeaders);
      res.end(responseBody);
    } catch (error) {
      if (!res.headersSent) json(res, 502, { ok: false, error: 'Backend tidak dapat dihubungi', detail: error.message });
      else res.destroy(error);
    }
  });

  req.on('error', (error) => {
    if (!res.headersSent) json(res, 400, { ok: false, error: error.message });
  });
}

function serveStatic(req, res) {
  let pathname;

  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  if (pathname === '/') pathname = '/index.html';

  const requested = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (requested !== PUBLIC_DIR && !requested.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(requested, (error, stat) => {
    if (error || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(requested).toLowerCase();
    const noCache = ['.html', '.js', '.css'].includes(ext) || pathname === '/sw.js';

    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': String(stat.size),
      'Cache-Control': noCache ? 'no-store, max-age=0' : 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    fs.createReadStream(requested).pipe(res);
  });
}

async function requestHandler(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;

  if (pathname === '/health') {
    const entries = await fsp.readdir(CACHE_DIR).catch(() => []);
    json(res, 200, {
      ok: true,
      backend: BACKEND_URL.origin,
      cacheDir: CACHE_DIR,
      cachedVideos: entries.filter((name) => name.endsWith('.mp4')).length,
    });
    return;
  }

  const streamMatch = /^\/api\/stream\/([A-Za-z0-9_-]+)$/.exec(pathname);
  if (streamMatch && ['GET', 'HEAD'].includes(req.method)) {
    const fileId = safeFileId(streamMatch[1]);
    if (!fileId) return json(res, 400, { ok: false, error: 'fileId tidak valid' });
    await serveVideo(req, res, fileId);
    return;
  }

  if (pathname.startsWith('/api/')) {
    proxyApi(req, res);
    return;
  }

  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }

  serveStatic(req, res);
}

module.exports = requestHandler;

if (require.main === module) {
  const server = http.createServer((req, res) => {
    Promise.resolve(requestHandler(req, res)).catch((error) => {
      console.error('[server]', error);
      if (!res.headersSent) json(res, 500, { ok: false, error: 'Internal Server Error' });
      else res.destroy(error);
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`Frontend : http://localhost:${PORT}`);
    console.log(`Backend  : ${BACKEND_URL.origin}`);
    console.log(`Video cache: ${CACHE_DIR}`);
  });
}
