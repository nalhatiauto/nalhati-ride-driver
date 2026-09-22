const CACHE_NAME = "nalhati-driver-v1";

self.addEventListener("install", event => {
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", event => {
  // Network থেকে স্বাভাবিকভাবেই ফাইল নেবে
});
