const fs = require("fs");
const { GoogleAuth } = require("google-auth-library");

const PROJECT_ID = "nalhati-ride";
const DATABASE_URL = "https://nalhati-ride-default-rtdb.firebaseio.com";
const FCM_URL = "https://fcm.googleapis.com/v1/projects/nalhati-ride/messages:send";
const statePath = "notification-state.json";
const debugPath = "notification-debug.json";
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

function writeDebug(data) {
  fs.writeFileSync(debugPath, JSON.stringify(data, null, 2) + "\n");
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
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const auth = new GoogleAuth({
    credentials: serviceAccount,
    scopes: [
      "https://www.googleapis.com/auth/firebase.database",
      "https://www.googleapis.com/auth/cloud-platform"
    ]
  });
  const client = await auth.getClient();
  const tokenResult = await client.getAccessToken();
  const token = typeof tokenResult === "string" ? tokenResult : tokenResult?.token;
  if (!token) throw new Error("Google access token was not returned.");
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
  return { id: doc.name.split("/").pop(), ...ride };
}

async function getSearchingRides(accessToken) {
  const baseUrl =
    "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID +
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

  return rides;
}

async function getDriverTokens(accessToken) {
  const tokenMap = new Map();

  const firestoreBase =
    "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID +
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
      const token = firestoreString((doc.fields || {}).fcmToken).trim();
      if (token) tokenMap.set(doc.name.split("/").pop(), token);
    }

    const next = data.nextPageToken;
    url = next ? firestoreBase + "?pageSize=100&pageToken=" + encodeURIComponent(next) : "";
  }

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
        if (token && !tokenMap.has(driverId)) tokenMap.set(driverId, token);
      }
    }
  } catch (error) {
    console.log("Realtime Database token fallback failed:", error.message);
  }

  return [...tokenMap.entries()].map(([driverId, token]) => ({ driverId, token }));
}

async function sendNotification(accessToken, ride, token) {
  const rideType =
    ride.rideType === "reserved" || ride.rideType === "reserve"
      ? "🚖 Reserved Ride"
      : "🚕 Shared Ride";
  const body = rideType + ": " + (ride.from || "Pickup Point") + " → " + (ride.to || "Drop Point");

  const message = {
    message: {
      token,
      notification: {
        title: "🔔 নতুন Booking এসেছে",
        body
      },
      data: {
        rideId: String(ride.id),
        type: "new_booking",
        rideType: String(ride.rideType || "shared")
      },
      webpush: {
        notification: {
          title: "🔔 নতুন Booking এসেছে",
          body
        },
        fcmOptions: {
          link: "https://nalhatiauto.github.io/nalhati-ride-driver/"
        }
      }
    }
  };

  const response = await fetchWithTimeout(FCM_URL, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + accessToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(message)
  });

  const text = await response.text();
  return response.ok
    ? { ok: true, status: response.status }
    : { ok: false, status: response.status, text: text.slice(0, 500) };
}

async function main() {
  const lastRun = readLastRun();
  const now = new Date();
  const debug = {
    checkedAt: now.toISOString(),
    previousLastRun: lastRun.toISOString(),
    newRides: 0,
    driverTokensFound: 0,
    successfulSends: 0,
    failedSends: 0,
    error: ""
  };

  try {
    const accessToken = await getAccessToken();
    const allRides = await getSearchingRides(accessToken);

    const rides = allRides.filter(ride => {
      const created = ride.createdAt instanceof Date ? ride.createdAt : new Date(ride.createdAt);
      return !Number.isNaN(created.getTime()) && created > lastRun && created <= now;
    });
    debug.newRides = rides.length;

    const drivers = await getDriverTokens(accessToken);
    debug.driverTokensFound = drivers.length;

    // Never advance lastRun when there is no token or a send fails.
    // This makes failed notifications retry on the next scheduled run.
    if (rides.length > 0 && drivers.length === 0) {
      debug.error = "No driver FCM token found.";
      writeDebug(debug);
      console.error(debug.error);
      process.exit(1);
    }

    let failed = false;

    for (const ride of rides) {
      for (const driver of drivers) {
        try {
          const result = await sendNotification(accessToken, ride, driver.token);
          if (result.ok) {
            debug.successfulSends++;
          } else {
            failed = true;
            debug.failedSends++;
            debug.error = "FCM HTTP " + result.status + ": " + result.text;
            console.error("Notification failed:", debug.error);
          }
        } catch (error) {
          failed = true;
          debug.failedSends++;
          debug.error = error.message;
          console.error("Notification request error:", error.message);
        }
      }
    }

    if (failed) {
      writeDebug(debug);
      console.error("Notification failed; lastRun was NOT advanced.");
      process.exit(1);
    }

    writeLastRun(now);
    writeDebug(debug);
    console.log("Notification check completed successfully.");
  } catch (error) {
    debug.error = error.message;
    writeDebug(debug);
    console.error("Notification worker failed:", error);
    process.exit(1);
  }
}

main();
