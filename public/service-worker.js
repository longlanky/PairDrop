const cacheVersion = 'v1.11.2';
const cacheTitle = `pairdrop-cache-${cacheVersion}`;
const relativePathsToCache = [
    './',
    'index.html',
    'manifest.json',
    'styles/styles-main.css',
    'styles/styles-deferred.css',
    'scripts/browser-tabs-connector.js',
    'scripts/localization.js',
    'scripts/main.js',
    'scripts/network.js',
    'scripts/persistent-storage.js',
    'scripts/ui.js',
    'scripts/ui-main.js',
    'scripts/util.js',
    'scripts/worker/canvas-worker.js',
    'scripts/libs/heic2any.min.js',
    'scripts/libs/no-sleep.min.js',
    'scripts/libs/qr-code.min.js',
    'scripts/libs/zip.min.js',
    'sounds/blop.mp3',
    'sounds/blop.ogg',
    'images/favicon-96x96.png',
    'images/favicon-96x96-notification.png',
    'images/android-chrome-192x192.png',
    'images/android-chrome-192x192-maskable.png',
    'images/android-chrome-512x512.png',
    'images/android-chrome-512x512-maskable.png',
    'images/apple-touch-icon.png',
    'fonts/OpenSans/static/OpenSans-Medium.ttf',
    'lang/ar.json',
    'lang/be.json',
    'lang/bg.json',
    'lang/ca.json',
    'lang/cs.json',
    'lang/da.json',
    'lang/de.json',
    'lang/en.json',
    'lang/es.json',
    'lang/et.json',
    'lang/eu.json',
    'lang/fa.json',
    'lang/fr.json',
    'lang/he.json',
    'lang/hu.json',
    'lang/id.json',
    'lang/it.json',
    'lang/ja.json',
    'lang/kn.json',
    'lang/ko.json',
    'lang/nb.json',
    'lang/nl.json',
    'lang/nn.json',
    'lang/pl.json',
    'lang/pt-BR.json',
    'lang/ro.json',
    'lang/ru.json',
    'lang/sk.json',
    'lang/ta.json',
    'lang/tr.json',
    'lang/uk.json',
    'lang/zh-CN.json',
    'lang/zh-HK.json',
    'lang/zh-TW.json'
];
const relativePathsNotToCache = [
    'config'
]

self.addEventListener('install', function(event) {
    // Perform install steps
    console.log("Cache files for sw:", cacheVersion);
    event.waitUntil(
        caches.open(cacheTitle)
            .then(function(cache) {
                return cache
                    .addAll(relativePathsToCache)
                    .then(_ => {
                        console.log('All files cached for sw:', cacheVersion);
                        self.skipWaiting();
                    });
            })
    );
});

// fetch the resource from the network
const fromNetwork = (request, timeout) =>
    new Promise((resolve, reject) => {
        const timeoutId = setTimeout(reject, timeout);
        fetch(request, {cache: "no-store"})
            .then(response => {
                if (response.redirected) {
                    throw new Error("Fetch is redirect. Abort usage and cache!");
                }

                clearTimeout(timeoutId);

                // Clone before the body is handed to the browser so the cached
                // copy reuses this response instead of fetching the same url again.
                const responseForCache = response.clone();
                resolve(response);

                // Prevent requests that are in relativePathsNotToCache from being cached
                if (doNotCacheRequest(request)) return;

                updateCache(request, responseForCache)
                    .then(() => console.log("Cache successfully updated for", request.url))
                    .catch(err => console.log("Cache could not be updated for", request.url, err));
            })
            .catch(error => {
                // Handle any errors that occurred during the fetch
                console.error(`Could not fetch ${request.url}.`);
                reject(error);
            });
    });

// fetch the resource from the browser cache
const fromCache = request =>
    caches
        .open(cacheTitle)
        .then(cache =>
            cache.match(request)
        );

const rootUrl = location.href.substring(0, location.href.length - "service-worker.js".length);
const rootUrlLength = rootUrl.length;

const doNotCacheRequest = request => {
    const requestRelativePath = request.url.substring(rootUrlLength);
    return relativePathsNotToCache.indexOf(requestRelativePath) !== -1
};

// cache the current page to make it available for offline
const updateCache = (request, response) =>
    caches
        .open(cacheTitle)
        .then(cache => {
            if (response.redirected) {
                throw new Error("Fetch is redirect. Abort usage and cache!");
            }
            return cache.put(request, response);
        });

// general strategy when making a request:
// 1. Try to retrieve file from cache
// 2. If cache is not available: Fetch from network and update cache.
// This way, cached files are only updated if the cacheVersion is changed
self.addEventListener('fetch', function(event) {
    const swOrigin = new URL(self.location.href).origin;
    const requestOrigin = new URL(event.request.url).origin;

    if (swOrigin !== requestOrigin) {
        // Do not handle requests from other origin
        event.respondWith(fetch(event.request));
    }
    else if (event.request.method === "POST") {
        // Requests related to Web Share Target.
        event.respondWith((async () => {
            const share_url = await evaluateRequestData(event.request);
            // share_url is built with the URL API and already properly encoded
            return Response.redirect(share_url, 302);
        })());
    }
    else {
        // Regular requests not related to Web Share Target:
        // If request is excluded from cache -> respondWith fromNetwork
        // else -> try fromCache first
        event.respondWith(
            doNotCacheRequest(event.request)
                ? fromNetwork(event.request, 10000)
                : fromCache(event.request)
                    .then(rsp => {
                        // if fromCache resolves to undefined fetch from network instead
                        if (!rsp) {
                            throw new Error("No match found.");
                        }
                        return rsp;
                    })
                    .catch(error => {
                        console.error("Could not retrieve request from cache:", event.request.url, error);
                        return fromNetwork(event.request, 10000);
                    })
        );
    }
});


// on activation, we clean up the previously registered service workers
self.addEventListener('activate', evt => {
    console.log("Activate sw:", cacheVersion);
    evt.waitUntil(clients.claim());
    return evt.waitUntil(
        caches
            .keys()
            .then(cacheNames => {
                return Promise.all(
                    cacheNames.map(cacheName => {
                        if (cacheName !== cacheTitle) {
                            console.log("Delete cache:", cacheName);
                            return caches.delete(cacheName);
                        }
                    })
                );
            })
    )
});

const evaluateRequestData = function (request) {
    return new Promise(async (resolve) => {
        const pairDropUrl = new URL(request.url);
        pairDropUrl.searchParams.delete('share_target');

        const filesErrorUrl = () => {
            const url = new URL(pairDropUrl);
            url.searchParams.set('share_target', 'files-error');
            return url.toString();
        };

        try {
            const formData = await request.formData();
            const title = formData.get("title");
            const text = formData.get("text");
            const url = formData.get("url");
            const files = formData.getAll("allfiles");

            if (files && files.length > 0) {
                let fileObjects = [];
                for (let i=0; i<files.length; i++) {
                    fileObjects.push({
                        name: files[i].name,
                        buffer: await files[i].arrayBuffer()
                    });
                }

                const DBOpenRequest = indexedDB.open('pairdrop_store');
                DBOpenRequest.onsuccess = e => {
                    const db = e.target.result;
                    db.onversionchange = _ => db.close();

                    let transaction;
                    try {
                        transaction = db.transaction('share_target_files', 'readwrite');
                    } catch (err) {
                        // the object store does not exist (database was created without it)
                        console.error("Could not open share_target_files object store", err);
                        db.close();
                        resolve(filesErrorUrl());
                        return;
                    }
                    const objectStore = transaction.objectStore('share_target_files');

                    for (let i = 0; i < fileObjects.length; i++) {
                        const objectStoreRequest = objectStore.add(fileObjects[i]);
                        objectStoreRequest.onsuccess = _ => {
                            if (i === fileObjects.length - 1) {
                                db.close();
                                pairDropUrl.searchParams.set('share_target', 'files');
                                resolve(pairDropUrl.toString());
                            }
                        }
                        // Without this the user is redirected to PairDrop without any
                        // files and without any hint that the share failed.
                        objectStoreRequest.onerror = e => {
                            console.error("Could not save shared file", e);
                            db.close();
                            resolve(filesErrorUrl());
                        }
                    }
                }
                DBOpenRequest.onerror = e => {
                    console.error("Could not open database to save shared files", e);
                    resolve(filesErrorUrl());
                }
                DBOpenRequest.onblocked = e => {
                    console.error("Opening database to save shared files was blocked", e);
                    resolve(filesErrorUrl());
                }
            }
            else {
                // use `URLSearchParams` so that values containing `&`, `=`, `#` or
                // whitespace cannot truncate or inject additional arguments
                pairDropUrl.searchParams.set('share_target', 'text');
                if (title) pairDropUrl.searchParams.set('title', title);
                if (text) pairDropUrl.searchParams.set('text', text);
                if (url) pairDropUrl.searchParams.set('url', url);

                resolve(pairDropUrl.toString());
            }
        } catch (e) {
            // e.g. the request body is not valid form data: without this the
            // redirect promise would never resolve and the share would hang
            console.error("Could not evaluate share target request", e);
            resolve(filesErrorUrl());
        }
    });
}
