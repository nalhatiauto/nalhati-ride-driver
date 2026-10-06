const fs = require("fs");
const { GoogleAuth } = require("google-auth-library");

const PROJECT_ID = "nalhati-ride";
const DATABASE_URL = "https://nalhati-ride-default-rtdb.firebaseio.com";
const FCM_URL = "https://fcm.googleapis.com/v1/projects/nalhati-ride/messages:send";
const statePath = "notification-state.json";
const TIMEOUT_MS = 10000;

function readLastRun() {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (state.lastRun) return new Date(state.lastRun);
  } catch (_) {}
  return new Date(Date.now() - 10 * 60 * 1000);
}

function writeLastRun(date) {
  fs.writeFileSync(statePath, JSON.stringify({ lastRun: date.toISOString() }, null, 2) + "\n");
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getAccessToken() {
  console.log("Creating Google access token...");
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const auth = new GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/firebase.database", "https://www.googleapis.com/auth/cloud-platform"]
  });
  const client = await auth.getClient();
  const tokenResult = await client.getAccessToken();
  const token = typeof tokenResult === "string" ? tokenResult : tokenResult?.token;
  if (!token) throw new Error("Google access token was not returned.");
  console.log("Google access token created.");
  return token;
}

function firestoreTimestamp(value) {
  if (!value) return null;
  if (value.timestampValue) return new Date(value.timestampValue);
  return null;
}

function firestoreString(value) {
  if (!value) return "";
  if (value.stringValue != null) return value.stringValue;
  if (value.integerValue != null) return String(value.integerValue);
  if (value.doubleValue != null) return String(value.doubleValue);
  if (value.booleanValue != null) return String(value.booleanValue);
  return "";
}

function documentToRide(doc) {
  const fields = doc.fields || {};
  const ride = {};
  for (const [key, value] of Object.entries(fields)) {
    ride[key] = firestoreString(value);
    if (value.timestampValue) ride[key] = firestoreTimestamp(value);
  }
  return {
    id: doc.name.split("/").pop(),
    ...ride
  };
}

async function getSearchingRides(accessToken) {
  console.log("Checking Firestore for new searching rides...");
  const baseUrl = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID +
    "/databases/(default)/documents/rides";
  let url = baseUrl + "?pageSize=100";
  const rides = [];

  while (url) {
    const response = await fetchWithTimeout(url, {
      headers: {
        Authorization: "Bearer " + accessToken,
        Accept: "application/json"
      }
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error("Firestore REST error " + response.status + ": " + text.slice(0, 500));
    }

    const data = text ? JSON.parse(text) : {};
    for (const doc of data.documents || []) {
      const ride = documentToRide(doc);
      if (ride.status === "searching") rides.push(ride);
    }

    const next = data.nextPageToken;
    url = next ? baseUrl + "?pageSize=100&pageToken=" + encodeURIComponent(next) : "";
  }

  console.log("Firestore returned", rides.length, "searching ride(s).");
  return rides;
}

async function getDriverTokens(accessToken) {
  console.log("Reading driver FCM tokens from Firestore and Realtime Database...");
  const tokenMap = new Map();

  // Primary source: Firestore.
  const firestoreBase = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID +
    "/databases/(default)/documents/drivers";
  let url = firestoreBase + "?pageSize=100";

  while (url) {
    const response = await fetchWithTimeout(url, {
      headers: { Authorization: "Bearer " + accessToken, Accept: "application/json" }
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error("Firestore drivers REST error " + response.status + ": " + text.slice(0, 500));
    }

    const data = text ? JSON.parse(text) : {};
    for (const doc of data.documents || []) {
      const fields = doc.fields || {};
      const token = firestoreString(fields.fcmToken).trim();
      if (token) {
        tokenMap.set(doc.name.split("/").pop(), token);
      }
    }

    const next = data.nextPageToken;
    url = next ? firestoreBase + "?pageSize=100&pageToken=" + encodeURIComponent(next) : "";
  }

  // Fallback/source of truth if Firestore token saving was unavailable.
  try {
    const response = await fetchWithTimeout(
      DATABASE_URL + "/drivers.json?access_token=" + encodeURIComponent(accessToken),
      { headers: { Accept: "application/json" } }
    );
    const text = await response.text();
    if (response.ok && text) {
      const data = JSON.parse(text) || {};
      for (const [driverId, driver] of Object.entries(data)) {
        const token = String(driver?.fcmToken || "").trim();
        if (token && !tokenMap.has(driverId)) {
          tokenMap.set(driverId, token);
        }
      }
    } else {
      console.log("Realtime Database token fallback unavailable:", response.status, text.slice(0, 300));
    }
  } catch (error) {
    console.log("Realtime Database token fallback failed:", error.message);
  }

  const drivers = [...tokenMap.entries()].map(([driverId, token]) => ({
    driverId,
    token
  }));

  console.log("Driver FCM tokens found:", drivers.length);
  return drivers;
}

