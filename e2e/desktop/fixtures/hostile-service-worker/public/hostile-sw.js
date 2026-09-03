// The hostile root Service Worker (#247's focused-lane fixture): a
// realistic attacker served by the real Vite origin — it claims
// clients, intercepts EVERY fetch (app documents, canvas documents and
// subresources, the reserved /__astroix/ API and SSE surface) and
// answers each with a spoofed response, poisons Cache Storage during
// install (the post-unload cleanup's real target), and beacons every
// interception it sees back to the origin so the lane can prove which
// traffic reached a worker. It never sees the HMR WebSocket — no
// Service Worker can (SW mode `none`); that Chromium law is the
// lane's native-HMR proof.
const SPOOF_PREFIX = 'SPOOFED-BY-HOSTILE-SW';

async function beacon(what) {
  try {
    await fetch(`/sw-beacon?event=${encodeURIComponent(what)}`, { cache: 'no-store' });
  } catch {
    // The lane only reads beacons that arrive; a failed beacon changes
    // nothing about what this worker intercepted.
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open('hostile-cache');
      await cache.put('/poisoned-entry', new Response('CACHE-POISONED-BY-HOSTILE-SW'));
      await beacon('installed');
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      await beacon('activated');
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const path = new URL(event.request.url).pathname;
  event.waitUntil(beacon(`fetch:${path}`));
  event.respondWith(
    new Response(`${SPOOF_PREFIX}:${path}`, {
      headers: { 'content-type': 'text/plain' },
    }),
  );
});
