// discodb2 copilot — service worker (PWA shell cache, P2).
//
// GOALS (and NON-goals):
//   • Make the app launch instantly and survive a flaky in-car link by caching
//     the SHELL (HTML + the hashed JS/CSS + the icon/manifest).
//   • "New version → refresh": when a new build is deployed the SW byte-changes,
//     installs as a WAITING worker, and the page surfaces a refresh prompt.
//   • Stay tiny and NOT interfere with the data path: the CAN/Wizard traffic is
//     a WebSocket (not HTTP) so it never touches this fetch handler; we also
//     bypass /ws, /health and any cross-origin or non-GET request entirely.
//
// Strategy:
//   • navigations  → network-first, fall back to the cached shell (offline).
//   • static GET   → cache-first (Vite asset names are content-hashed → immutable),
//                    with a background cache fill on a miss.
//
// Bump CACHE on any change to this file's strategy to force a clean activation.
// (Hashed asset URLs already self-invalidate; this version guards the shell.)

const CACHE = "copilot-shell-v1";

// The minimal shell to precache. Hashed JS/CSS are added lazily at runtime
// (their names are unknown here and change every build); these stable URLs are
// enough to boot offline and render the chrome.
const PRECACHE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      // Do NOT auto-skipWaiting: we want a deliberate, user-acknowledged refresh
      // (the page posts SKIP_WAITING when the operator taps "refresh"). This
      // avoids swapping code under the driver mid-glance.
      .catch(() => {
        /* a precache miss must not abort install */
      }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

// Let the page trigger the swap once the operator acknowledges the new version.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

function isHtmlNavigation(request) {
  return (
    request.mode === "navigate" ||
    (request.method === "GET" &&
      (request.headers.get("accept") || "").includes("text/html"))
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Only same-origin GET is cacheable. WebSocket upgrades, POSTs, cross-origin
  // (e.g. a split backend host) and the health/ws endpoints pass straight
  // through to the network — the SW never sits on the data path.
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith("/ws") || url.pathname.endsWith("/health")) return;

  if (isHtmlNavigation(request)) {
    // Network-first so an online launch always pulls the latest asset refs;
    // fall back to the cached shell when offline.
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("./index.html", copy)).catch(() => {});
          return res;
        })
        .catch(() =>
          caches
            .match("./index.html", { ignoreSearch: true })
            .then((r) => r || caches.match("./")),
        ),
    );
    return;
  }

  // Static assets (hashed JS/CSS, icons): cache-first, fill on miss.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((res) => {
          if (res && res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
    }),
  );
});
