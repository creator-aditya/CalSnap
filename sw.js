/**
 * CalSnap service worker.
 *
 * Its only job is to make the application shell available offline (and to make
 * the installed app start instantly). It deliberately ignores everything else:
 *
 *  - only same-origin GET requests are handled;
 *  - the manifest and the service worker itself are always fetched from the
 *    network so a deployment is picked up on the next visit;
 *  - page navigations are network-first, so a shared link (?text=...&url=...)
 *    always reaches the real page instead of a cached copy without the query.
 *
 * Assets are listed with relative paths so the app also works when it is served
 * from a sub-path, e.g. https://user.github.io/calsnap/.
 */

const CACHE_NAME = 'calsnap-v2';
const SHELL_ASSETS = [
    './',
    './index.html',
    './style.css',
    './js/extractor.js',
    './js/validation.js',
    './js/calendar.js',
    './js/ui.js',
    './manifest.json',
    './icon.png',
    './icon-192.png',
    './icon-512.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(SHELL_ASSETS))
            .catch(() => undefined) // a missing optional asset must not break install
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((names) => Promise.all(
                names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.endsWith('/manifest.json') || url.pathname.endsWith('/sw.js')) return;

    // Navigations: network first, so shared text in the query string is honoured.
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    const copy = response.clone();
                    caches.open(CACHE_NAME)
                        .then((cache) => cache.put(request, copy))
                        .catch(() => undefined);
                    return response;
                })
                .catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html')))
        );
        return;
    }

    // Static assets: cache first, refreshed in the background.
    event.respondWith(
        caches.match(request).then((cached) => {
            if (cached) return cached;
            return fetch(request).then((response) => {
                if (response && response.status === 200 && response.type === 'basic') {
                    const copy = response.clone();
                    caches.open(CACHE_NAME)
                        .then((cache) => cache.put(request, copy))
                        .catch(() => undefined);
                }
                return response;
            });
        })
    );
});
