const SHARE_CACHE = 'bookdrop-share';
const PENDING_KEY = '/pending-share';

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
          }),
        );
      }

      return Response.redirect('/', 303);
    })(),
  );
});
