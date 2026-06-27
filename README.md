# TikTok Clone V2 Frontend — Final 2.2.0

UI asli dipertahankan. Versi ini memakai proxy API same-origin dan proxy video berbasis cache sementara agar elemen `<video>` menerima header byte-range yang benar.

## Jalankan di Windows

Tidak perlu `npm install`.

```powershell
npm run dev
```

Atau klik dua kali `START-FRONTEND.bat`.

Buka:

```text
http://localhost:3000
```

## Backend

Default:

```text
https://backend-production-9036.up.railway.app
```

Untuk mengganti backend:

```powershell
$env:BACKEND_URL="https://domain-backend.example"
npm run dev
```

## Cara kerja video

Permintaan `/api/stream/:fileId` diambil sekali dari backend, disimpan di folder cache sementara sistem, lalu disajikan kembali dengan:

- `206 Partial Content`
- `Accept-Ranges: bytes`
- `Content-Range`
- `Content-Length`

Ini mengatasi kasus backend mengirim `206` tetapi tidak meneruskan `Content-Range` dan `Content-Length`.

## Cek server

```text
http://localhost:3000/health
```

## Deploy Vercel

Repository dapat di-import langsung ke Vercel. `vercel.json` sudah memasang `server.js` sebagai proxy API dan folder `public` sebagai aset statis. Variabel opsional:

```text
BACKEND_URL=https://backend-production-9036.up.railway.app
```

Catatan: cache video Vercel bersifat sementara karena menggunakan filesystem serverless. Untuk trafik besar, solusi terbaik tetap memperbaiki header range pada backend.
