// Keeps the app's own files on the device so it opens offline.
// Online, it always fetches the latest version first, so updates arrive without reinstalling.
const CACHE = "meadowmount-app-v1";
const APP_FILES = ["./", "index.html", "styles.css", "config.js", "dropbox.js", "app.js"];
const NETWORK_TIMEOUT = 4000;

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key.startsWith("meadowmount-app-") && key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

// A slow connection falls back to the saved copy rather than leaving the page blank.
function fetchWithTimeout(request) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), NETWORK_TIMEOUT);
    fetch(request, { cache: "no-cache" }).then(
      response => { clearTimeout(timer); resolve(response); },
      error => { clearTimeout(timer); reject(error); });
  });
}

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  // Dropbox calls and the score copies (kept by the page itself) are left alone.
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.includes("/__scores__/")) return;
  // Every page visit, including Dropbox's sign-in return (?code=…), is stored as the one app page.
  const key = event.request.mode === "navigate" ? new URL("./", self.registration.scope).href : event.request;
  event.respondWith((async () => {
    try {
      const response = await fetchWithTimeout(event.request);
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then(cache => cache.put(key, copy)));
      }
      return response;
    } catch {
      const cached = await caches.match(key, { ignoreSearch: true });
      return cached || Response.error();
    }
  })());
});
