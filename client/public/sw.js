const SHARE_CACHE = 'bookdrop-share';
const PENDING_KEY = '/pending-share';
const MAX_SHARED_URL_LENGTH = 2048;

// Minimal mirror of extractSharedUrl() in src/utils.ts — a service worker can't
// import from src/, so keep the two in sync. The canonical, tested version is in src/.
function extractSharedUrl(url, text) {
  const isHttp = (s) => {
    try {
      const p = new URL(s).protocol;
      return p === 'http:' || p === 'https:';
    } catch {
      return false;
    }
  };
  const u = typeof url === 'string' ? url.trim() : '';
  if (u && u.length <= MAX_SHARED_URL_LENGTH && isHttp(u)) {
    return u;
  }
  const t = typeof text === 'string' ? text : '';
  const match = t.match(/https?:\/\/[^\s]+/i);
  if (match) {
    const candidate = match[0].replace(/[.,;:!?)\]}>"']+$/, '');
    if (candidate.length <= MAX_SHARED_URL_LENGTH && isHttp(candidate)) {
      return candidate;
    }
  }
  return null;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || url.pathname !== '/share') {
    return;
  }

  event.respondWith(
    (async () => {
      const formData = await event.request.formData();
      const file = formData.get('file');

      if (file instanceof File) {
        const cache = await caches.open(SHARE_CACHE);
        await cache.put(
          PENDING_KEY,
          new Response(file, {
            headers: {
              'Content-Type': file.type || 'application/octet-stream',
              'X-File-Name': encodeURIComponent(file.name),
            },
          })
        );
        return Response.redirect('/', 303);
      }

      // No file — this was a link/text share (e.g. an article shared from a browser).
      const shared = extractSharedUrl(formData.get('url'), formData.get('text'));
      return Response.redirect(shared ? `/?shared_url=${encodeURIComponent(shared)}` : '/', 303);
    })()
  );
});
