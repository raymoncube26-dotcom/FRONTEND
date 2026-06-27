# QA Report — Frontend 2.2.0

Validated on 2026-06-27:

- `node --check server.js`: passed
- `node --check public/app.js`: passed
- `node --check public/sw.js`: passed
- Static HTML delivery: passed
- API JSON proxy: passed
- Video cache download from an upstream response with missing range headers: passed
- `206 Partial Content`: passed
- `Content-Range`: passed
- `Content-Length`: passed
- Suffix byte range: passed
- Full MP4 integrity comparison: passed
- FFprobe decode of proxied MP4: passed
- UI source files preserved; only cache-busting version values changed
