/* Hors ligne : on sert le cache tout de suite et on le rafraîchit en arrière-plan.
   Une mise à jour publiée apparaît donc au deuxième lancement de l'appli. */
const CACHE = 'agregatix-v2';
const SOCLE = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'vendor/katex/katex.min.js', 'vendor/katex/katex.min.css', 'data/index.json', 'icons/icon-192.png'];

const POLICES = ['AMS-Regular', 'Caligraphic-Regular', 'Main-Bold', 'Main-Italic', 'Main-Regular', 'Math-Italic',
  'Size1-Regular', 'Size2-Regular', 'Size3-Regular', 'Size4-Regular'].map(n => `vendor/katex/fonts/KaTeX_${n}.woff2`);

self.addEventListener('install', ev => {
  ev.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SOCLE.concat(POLICES));
    // Les fichiers de cartes sont listés par index.json : on les met tous en cache d'emblée.
    const programme = await (await fetch('data/index.json')).json();
    const lots = programme.domaines.flatMap(d => d.chapitres).filter(c => c.cartes).map(c => `data/cartes/${c.id}.json`);
    await cache.addAll(lots);
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', ev => {
  ev.waitUntil(caches.keys().then(noms => Promise.all(noms.filter(n => n !== CACHE).map(n => caches.delete(n)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  ev.respondWith(caches.open(CACHE).then(async cache => {
    const enCache = await cache.match(req, { ignoreSearch: true });
    const reseau = fetch(req).then(rep => { if (rep.ok) cache.put(req, rep.clone()); return rep; }).catch(() => enCache);
    return enCache || reseau;
  }));
});
