importScripts("https://www.gstatic.com/firebasejs/12.19.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyD4gHM7Gx061qBHSvK-JEQg0HW9EO5z84c",
  authDomain: "nalhati-ride.firebaseapp.com",
  databaseURL: "https://nalhati-ride-default-rtdb.firebaseio.com",
  projectId: "nalhati-ride",
  storageBucket: "nalhati-ride.firebasestorage.app",
  messagingSenderId: "1077953215118",
  appId: "1:1077953215118:web:7d73eac073d30523dda7df",
  measurementId: "G-BPZT7JKDH7"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log("Background notification:", payload);

  const title =
    payload.notification?.title || "🚕 Nalhati Ride";

  const options = {
    body:
      payload.notification?.body ||
      "নতুন Ride Booking এসেছে।",
    icon: "/icon-192.png",
    badge: "/icon-192.png"
  };

  self.registration.showNotification(title, options);
});
