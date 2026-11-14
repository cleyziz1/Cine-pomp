// Service Worker de limpeza: remove qualquer SW antigo que bloqueava o streaming por CORS.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    self.registration.unregister().then(() => self.clients.matchAll()).then((clients) => {
      clients.forEach((client) => {
        if (client.url && 'navigate' in client) {
          // Apenas libera os clientes sem forçar loop
        }
      });
    })
  );
});
