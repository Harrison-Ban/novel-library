// 서비스 워커: 앱 파일을 기기에 저장해 빨리 열고, 배포마다 새 버전으로 바꾼다 (F15)
// OneDrive·로그인 요청(다른 주소)과 version.json은 저장하지 않고 항상 네트워크로 보낸다.
const BUILD = 'dev';
const CACHE = `novel-library-${BUILD}`;
// 배포할 때 GitHub Actions가 실제 파일 목록으로 바꾼다
const PRECACHE = ['./', 'index.html'];
const NEVER_CACHE = ['version.json', 'sw.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })))),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('novel-library-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHE.some((name) => url.pathname.endsWith(`/${name}`))) return;

  if (req.mode === 'navigate') {
    // 로그인 후 돌아올 때(#code=…)도 같은 앱 화면을 쓴다
    event.respondWith(caches.match('index.html').then((hit) => hit || fetch(req)));
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  })());
});
