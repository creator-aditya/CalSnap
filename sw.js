/**
 * CalSnap service worker.
 *
 * It provides two things:
 *   1. an offline copy of the application shell, and
 *   2. an instant start for the installed app.
 *
 * Fetch strategy - the important part:
 *
 *   navigations and the application's own code (HTML, CSS, JS, manifest)
 *       -> NETWORK FIRST. Whenever the device is online, the newest deployed
 *          version wins, so a code change can never be hidden behind a stale cache.
 *          The cache is only used when the network fails.
 *   icons and other static assets
 *       -> CACHE FIRST, refreshed in the background. These change rarely and
 *          loading them instantly is what makes the app feel native.
 *   anything else (including other origins)
 *       -> not handled at all.
 *
 * CACHE_NAME must be changed whenever a cached asset changes. It is bumped by
 * hand here because the project has no build step to hash files automatically.
 * Even if a bump is forgotten, the network-first rule above still delivers fresh
 * code; the bump only controls how quickly the offline copy is replaced.
 */

const CACHE_NAME = 'calsnap-v3';
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

/** Code and documents: always try the network first so updates are never stale. */
function isFreshAsset(url) {
    return url.pathname.endsWith('/') || /\.(?:html|css|js|json)$/i.test(url.pathname);
}

function fromCache(request, fallback) {
    return caches.match(request).then((cached) => cached || (fallback ? caches.match(fallback) : undefined));
}

function refresh(request, response) {
    if (!response || response.status !== 200 || response.type !== 'basic') return response;
    const copy = response.clone();
    caches.open(CACHE_NAME)
        .then((cache) => cache.put(request, copy))
        .catch(() => undefined);
    return response;
}

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

    if (request.mode === 'navigate' || isFreshAsset(url)) {
        // Network first: a deployed change is picked up on the next load.
        event.respondWith(
            fetch(request)
                .then((response) => refresh(request, response))
                .catch(() => fromCache(request, './index.html'))
        );
        return;
    }

    // Icons and other rarely changing files: cache first, refreshed in the background.
    event.respondWith(
        caches.match(request).then((cached) => {
            if (cached) {
                fetch(request)
                    .then((response) => refresh(request, response))
                    .catch(() => undefined);
                return cached;
            }
            return fetch(request).then((response) => refresh(request, response));
        })
    );
});
