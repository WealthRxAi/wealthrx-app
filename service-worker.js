var CACHE_NAME = 'wealthrx-v1';
var urlsToCache = [
  '/',
  '/login.html',
  '/dashboard.html',
  '/onboarding.html',
  '/manifest.json'
];

// Install event - cache key files
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function(cache) {
        return cache.addAll(urlsToCache);
      })
      .catch(function(err) {
        console.log('Cache install failed:', err);
      })
  );
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames.map(function(cacheName) {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch event - serve from cache when offline
self.addEventListener('fetch', function(event) {
  // Only cache GET requests
  if (event.request.method !== 'GET') return;
  
  // Don't cache API calls
  if (event.request.url.indexOf('/api/') !== -1) return;
  
  // Don't cache Supabase or external API calls
  if (event.request.url.indexOf('supabase') !== -1) return;
  if (event.request.url.indexOf('plaid') !== -1) return;
  if (event.request.url.indexOf('anthropic') !== -1) return;

  event.respondWith(
    fetch(event.request)
      .then(function(response) {
        return response;
      })
      .catch(function() {
        // Offline - serve from cache
        return caches.match(event.request);
      })
  );
});

// Push notification event - receive push from server
self.addEventListener('push', function(event) {
  var data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { title: 'WealthRx', body: event.data.text() };
    }
  }

  var title = data.title || 'WealthRx Alert';
  var options = {
    body: data.body || 'New transaction update',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200],
    tag: 'wealthrx-' + Date.now(),
    requireInteraction: false,
    data: {
      url: data.url || 'https://app.wealthrx.ai/dashboard.html'
    }
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// Notification click - open app
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var url = event.notification.data.url || 'https://app.wealthrx.ai/dashboard.html';
  
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(function(clientList) {
      // If app is already open, focus it
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url.indexOf('wealthrx') !== -1 && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open new window
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});
