// オフライン用：アプリ本体（HTML/CSS/JS/アイコン）だけをキャッシュする。日記データはIndexedDB。
// ネットにつながるときは最新版を取りに行き、つながらない・遅い・サーバーエラーのときはキャッシュを使う。
// ファイルを追加・削除したら ASSETS と CACHE の番号を更新すること。
const PREFIX = 'diary-';
const CACHE = PREFIX + 'v3';
const ASSETS = ['./', 'index.html', 'style.css', 'store.js', 'app.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];
const ASSET_URLS = new Set(ASSETS.map((p) => new URL(p, self.registration.scope).href));
const TIMEOUT = 4000; // これ以上待たせずキャッシュを使う

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  // このアプリの古いキャッシュだけを消す（同じドメインの他アプリのキャッシュには触らない）
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  url.search = '';
  const isPage = req.mode === 'navigate';
  if (req.method !== 'GET' || (!isPage && !ASSET_URLS.has(url.href))) return; // アプリ本体以外は素通し

  const fromCache = () => caches.match(isPage ? 'index.html' : req, { ignoreSearch: true });
  const network = fetch(req, { cache: 'no-cache' }).then((res) => {
    if (!res.ok) throw new Error(res.status);
    const copy = res.clone();
    const put = caches.open(CACHE).then((c) => c.put(isPage ? 'index.html' : req, copy));
    try { e.waitUntil(put); } catch {} // タイムアウト後に届いた場合はイベントが終わっているので追跡しない
    return res;
  });
  network.catch(() => {}); // タイムアウトで使われなかった場合の未処理エラーを防ぐ
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT));

  e.respondWith(
    Promise.race([network, timeout])
      .catch(() => fromCache().then((hit) => hit || network)) // キャッシュもなければネットの結果を待つ
  );
});
