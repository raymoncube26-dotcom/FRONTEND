const feed = document.getElementById('feed');
const videoCounter = document.getElementById('videoCounter');
const offlineToggle = document.getElementById('offlineToggle');
const offlinePanel = document.getElementById('offlinePanel');
const closeOffline = document.getElementById('closeOffline');
const downloadStatus = document.getElementById('downloadStatus');
const progressFill = document.getElementById('progressFill');
const deleteOffline = document.getElementById('deleteOffline');
const offlineCount = document.getElementById('offlineCount');
const offlineSize = document.getElementById('offlineSize');
const exitFullscreenBtn = document.getElementById('exitFullscreenBtn');

const API_BASE_URL = ''; // same-origin proxy: lokal dan Vercel

let videos = [];
let currentIndex = 0;
let isChanging = false;
let touchStartY = 0;
let db = null;
let isDownloading = false;

const DB_NAME = 'tiktokOfflineDB';
const DB_VERSION = 1;
const STORE_NAME = 'videos';
const BATCH_SIZE = 50;

init();

async function init() {
  await openDB();
  await registerSW();
  await requestPersistentStorage();
  updateOnlineStatus();
  await updateOfflineStats();
  await loadVideos();
}

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, {
          keyPath: 'fileId'
        });

        store.createIndex('savedAt', 'savedAt');
      }
    };

    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };

    request.onerror = () => reject(request.error);
  });
}

async function registerSW() {
  if ('serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
      await registration.update();
    } catch (err) {
      console.warn('SW gagal:', err);
    }
  }
}

async function requestPersistentStorage() {
  if (navigator.storage && navigator.storage.persist) {
    try {
      await navigator.storage.persist();
    } catch (err) {
      console.warn('Persistent storage gagal:', err);
    }
  }
}


function normalizeVideoItem(item) {
  return {
    fileId: item.fileId || item.drive_file_id || item.driveFileId || '',
    title: item.title || item.caption || item.fileName || item.filename || 'Video',
    fileName: item.fileName || item.filename || '',
    mimeType: item.mimeType || 'video/mp4',
    size: item.size || item.file_size || null,
    createdTime: item.createdTime || item.created_at || '',
    modifiedTime: item.modifiedTime || item.modified_at || '',
    username: item.username || '',
    caption: item.caption || '',
    hashtag: item.hashtag || '',
    tiktokUrl: item.tiktokUrl || item.tiktok_url || item.sourceUrl || '',
    driveUrl: item.driveUrl || item.drive_url || '',
    offline: item.offline || false,
    blob: item.blob || null
  };
}

function mapOfflineVideo(item) {
  return normalizeVideoItem({
    fileId: item.fileId,
    title: item.title,
    fileName: item.fileName,
    mimeType: item.mimeType,
    username: item.username,
    caption: item.caption,
    hashtag: item.hashtag,
    tiktokUrl: item.tiktokUrl,
    driveUrl: item.driveUrl,
    offline: true,
    blob: item.blob
  });
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function loadVideos() {
  const offlineVideos = await getAllOfflineVideos();

  if (!navigator.onLine) {
    if (offlineVideos.length === 0) {
      feed.innerHTML = `<div class="empty">Offline mode aktif.<br>Belum ada video offline.</div>`;
      updateCounter(0, 0);
      return;
    }

    videos = shuffleArray(
      offlineVideos.map(mapOfflineVideo)
    );

    currentIndex = 0;
    renderActiveVideo();
    return;
  }

try {
  const res = await fetch(`${API_BASE_URL}/api/videos?limit=500&offset=0`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  const data = await res.json();

  const list = Array.isArray(data) ? data : (data.items || data.videos || []);

  if (!list.length) {
    feed.innerHTML = `<div class="empty">Belum ada video</div>`;
    updateCounter(0, 0);
    return;
  }

  videos = shuffleArray(list.map(normalizeVideoItem).filter(item => item.fileId));
  currentIndex = 0;
  renderActiveVideo();
} catch (err) {

    console.warn('Online gagal, fallback ke IndexedDB', err);

    if (offlineVideos.length > 0) {
      videos = shuffleArray(
        offlineVideos.map(mapOfflineVideo)
      );

      currentIndex = 0;
      renderActiveVideo();
      return;
    }

    feed.innerHTML = `<div class="empty">Gagal load video</div>`;
    updateCounter(0, 0);
  }
}

function renderActiveVideo() {
  destroyAllVideos();

  const item = videos[currentIndex];

  if (!item) {
    feed.innerHTML = `<div class="empty">Video tidak ditemukan</div>`;
    updateCounter(0, 0);
    return;
  }

  feed.innerHTML = '';

  const card = document.createElement('section');
  card.className = 'video-card';

  const src = item.offline
    ? URL.createObjectURL(item.blob)
    : `${API_BASE_URL}/api/stream/${encodeURIComponent(item.fileId)}`;

card.innerHTML = `
  <video
    class="video-main"
    src="${src}"
    playsinline
    preload="auto"
    loop
    controls
  ></video>

  <button class="fullscreen-btn" type="button">⛶</button>
`;

  feed.appendChild(card);

  const videoEl = card.querySelector('.video-main');
  const fullscreenBtn = card.querySelector('.fullscreen-btn');

  let uiTimer = null;

  function showVideoUi() {
  clearTimeout(uiTimer);

  card.classList.remove('show-ui');

  setTimeout(() => {
    card.classList.add('show-ui');
  }, 250);

  uiTimer = setTimeout(() => {
    card.classList.remove('show-ui');
  }, 3130);
}

  videoEl.addEventListener('click', showVideoUi);
  videoEl.addEventListener('touchstart', showVideoUi, { passive: true });
  videoEl.addEventListener('mousemove', showVideoUi);
  videoEl.addEventListener('play', showVideoUi);
  videoEl.addEventListener('pause', showVideoUi);

  fullscreenBtn.addEventListener('click', async () => {
    document.body.classList.add('web-fullscreen');

    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
    }

    videoEl.play().catch(() => {});
  });

  videoEl.dataset.blobUrl = item.offline ? src : '';

  updateCounter(currentIndex + 1, videos.length);

  videoEl.play().catch(() => {});
}

function goToVideo(nextIndex) {
  if (isChanging) return;
  if (nextIndex < 0 || nextIndex >= videos.length) return;
  if (nextIndex === currentIndex) return;

  isChanging = true;
  currentIndex = nextIndex;
  renderActiveVideo();

  setTimeout(() => {
    isChanging = false;
  }, 650);
}

function destroyAllVideos() {
  document.querySelectorAll('.video-main').forEach(video => {
    const blobUrl = video.dataset.blobUrl;

    video.pause();
    video.removeAttribute('src');
    video.src = '';
    video.load();

    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
    }

    video.remove();
  });
}
async function requestDownloadNotificationPermission() {
  if (!('Notification' in window)) return false;

  if (Notification.permission === 'granted') {
    return true;
  }

  if (Notification.permission !== 'denied') {
    const permission = await Notification.requestPermission();
    return permission === 'granted';
  }

  return false;
}

async function showDownloadNotification(title, body) {
  if (!('serviceWorker' in navigator)) return;
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  const registration = await navigator.serviceWorker.ready;

  registration.showNotification(title, {
    body,
    tag: 'offline-download',
    renotify: false,
    silent: true,
    icon: '/favicon.png',
    badge: '/favicon.png'
  });
}

async function downloadOffline(count) {
  if (isDownloading) {
    setStatus('Download masih berjalan...');
    return;
  }

  if (!navigator.onLine) {
    setStatus('Kamu sedang offline.');
    return;
  }

  if (!videos.length) {
    setStatus('Video belum siap.');
    return;
  }

  isDownloading = true;

await requestDownloadNotificationPermission();

const selected = videos.slice(0, count);

await showDownloadNotification(
  'Download video offline',
  `Sedang menyimpan ${selected.length} video ke perangkat.`
);

  let saved = 0;
  let failed = 0;

  setProgress(0);
  setStatus(`Mulai download 0 / ${selected.length}`);

  try {
    for (let i = 0; i < selected.length; i += BATCH_SIZE) {
      const batch = selected.slice(i, i + BATCH_SIZE);

      for (const video of batch) {
        try {
          const exists = await getOfflineVideo(video.fileId);

          if (!exists) {
           const response = await fetch(`${API_BASE_URL}/api/stream/${encodeURIComponent(video.fileId)}`);

            if (!response.ok) {
              throw new Error('Fetch gagal');
            }

            const blob = await response.blob();

            await saveVideoToDB({
              fileId: video.fileId,
              title: video.title || video.fileName || 'Offline Video',
              fileName: video.fileName || '',
              mimeType: blob.type || video.mimeType || 'video/mp4',
              username: video.username || '',
              caption: video.caption || '',
              hashtag: video.hashtag || '',
              tiktokUrl: video.tiktokUrl || '',
              driveUrl: video.driveUrl || '',
              blob,
              savedAt: new Date().toISOString()
            });
          }

          saved++;
        } catch (err) {
          failed++;
          console.error('Gagal simpan:', video.fileId, err);
        }

        const done = saved + failed;
        setProgress((done / selected.length) * 100);
        setStatus(`Downloading ${done} / ${selected.length} | Saved: ${saved} | Failed: ${failed}`);

        await sleep(80);
      }

      await sleep(700);
    }

    setProgress(100);
setStatus(`Selesai. Saved: ${saved} | Failed: ${failed}`);
await updateOfflineStats();

await showDownloadNotification(
  'Download selesai',
  `Saved: ${saved} | Failed: ${failed}`
);
  } finally {
    isDownloading = false;
  }
}

function saveVideoToDB(video) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    store.put(video);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function getOfflineVideo(fileId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(fileId);

    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function getAllOfflineVideos() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();

    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function clearOfflineVideos() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    store.clear();

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteAllOfflineVideos() {
  if (isDownloading) {
    alert('Download masih berjalan. Tunggu selesai dulu.');
    return;
  }

  const yakin = confirm('Hapus semua video offline dari IndexedDB?');

  if (!yakin) return;

  destroyAllVideos();

  await clearOfflineVideos();
  await updateOfflineStats();

  setProgress(0);
  setStatus('Semua video offline sudah dihapus');

  alert('Semua video offline berhasil dihapus');

  if (!navigator.onLine) {
    videos = [];
    feed.innerHTML = `<div class="empty">Offline mode aktif.<br>Belum ada video offline.</div>`;
    updateCounter(0, 0);
  }
}

async function updateOfflineStats() {
  const offlineVideos = await getAllOfflineVideos();

  let totalBytes = 0;

  offlineVideos.forEach(video => {
    if (video.blob && video.blob.size) {
      totalBytes += video.blob.size;
    }
  });

  if (offlineCount) {
    offlineCount.textContent = offlineVideos.length;
  }

  if (offlineSize) {
    offlineSize.textContent = formatBytes(totalBytes);
  }
}

function formatBytes(bytes) {
  if (!bytes) return '0 MB';

  const mb = bytes / 1024 / 1024;
  const gb = mb / 1024;

  if (gb >= 1) {
    return `${gb.toFixed(2)} GB`;
  }

  return `${mb.toFixed(1)} MB`;
}

function updateOnlineStatus() {
  if (!offlineToggle) return;

  if (navigator.onLine) {
    offlineToggle.textContent = 'Online';
    offlineToggle.classList.add('online');
    offlineToggle.classList.remove('offline');
  } else {
    offlineToggle.textContent = 'Offline';
    offlineToggle.classList.add('offline');
    offlineToggle.classList.remove('online');
  }
}

function setStatus(text) {
  if (!downloadStatus) return;
  downloadStatus.textContent = text;
}

function setProgress(percent) {
  if (!progressFill) return;
  progressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

function updateCounter(current, total) {
  if (!videoCounter) return;
  videoCounter.textContent = `${current} / ${total}`;
}

if (videoCounter) {
  videoCounter.style.cursor = 'pointer';

  videoCounter.addEventListener('click', () => {
    location.reload();
  });
}

function shuffleArray(array) {
  const copy = [...array];

  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }

  return copy;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

if (feed) {
  feed.addEventListener('wheel', (e) => {
    if (offlinePanel.classList.contains('show')) return;

    e.preventDefault();

    if (e.deltaY > 30) goToVideo(currentIndex + 1);
    if (e.deltaY < -30) goToVideo(currentIndex - 1);
  }, { passive: false });

  feed.addEventListener('touchstart', (e) => {
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  feed.addEventListener('touchend', (e) => {
    if (offlinePanel.classList.contains('show')) return;

    const diff = touchStartY - e.changedTouches[0].clientY;

    if (Math.abs(diff) < 55) return;

    if (diff > 0) goToVideo(currentIndex + 1);
    else goToVideo(currentIndex - 1);
  }, { passive: true });
}

document.addEventListener('keydown', (e) => {
  if (offlinePanel.classList.contains('show')) return;

  if (e.key === 'ArrowDown') goToVideo(currentIndex + 1);
  if (e.key === 'ArrowUp') goToVideo(currentIndex - 1);
});

offlineToggle.addEventListener('click', async () => {
  destroyAllVideos();
  await updateOfflineStats();
  offlinePanel.classList.add('show');
});

closeOffline.addEventListener('click', () => {
  offlinePanel.classList.remove('show');
  renderActiveVideo();
});

document.querySelectorAll('.download-options button[data-count]').forEach(button => {
  button.addEventListener('click', () => {
    const count = Number(button.dataset.count);
    downloadOffline(count);
  });
});

if (deleteOffline) {
  deleteOffline.addEventListener('click', deleteAllOfflineVideos);
}
if (exitFullscreenBtn) {
  exitFullscreenBtn.addEventListener('click', async () => {
    document.body.classList.remove('web-fullscreen');

    if (document.fullscreenElement) {
      await document.exitFullscreen();
    }
  });
}



const resetSiteBtn = document.getElementById('resetSiteBtn');

if (resetSiteBtn) {
  resetSiteBtn.addEventListener('click', async () => {
    const yakin = confirm('Reset website? Service Worker, Cache, dan video offline akan dihapus.');

    if (!yakin) return;

    try {
      setStatus('Reset site berjalan...');

      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();

        for (const reg of registrations) {
          await reg.unregister();
        }
      }

      if ('caches' in window) {
        const cacheNames = await caches.keys();

        for (const name of cacheNames) {
          await caches.delete(name);
        }
      }

      indexedDB.deleteDatabase('tiktokOfflineDB');

      setProgress(0);
      setStatus('Reset selesai');

      alert('Reset selesai. Website akan reload.');

      setTimeout(() => {
        location.href = '/';
      }, 500);
    } catch (err) {
      console.error(err);
      alert('Gagal reset site. Cek console.');
    }
  });
}
window.addEventListener('load', () => {
  setTimeout(() => {
    const splash = document.getElementById('splash');

    if (splash) {
      splash.classList.add('hide');

      setTimeout(() => {
        splash.remove();
      }, 500);
    }
  }, 1500);
});
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);

window.addEventListener('beforeunload', () => {
  destroyAllVideos();
});