const fs = require("fs");
const { GoogleAuth } = require("google-auth-library");

const PROJECT_ID = "nalhati-ride";
const DATABASE_URL = "https://nalhati-ride-default-rtdb.firebaseio.com";
const FCM_URL = "https://fcm.googleapis.com/v1/projects/nalhati-ride/messages:send";
const statePath = "notification-state.json";
const TIMEOUT_MS = 15000;

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
  const url = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID +
    "/databases/(default)/documents:runQuery";

  const body = {
    structuredQuery: {
      from: [{ collectionId: "rides" }],
      where: {
        fieldFilter: {
          field: { fieldPath: "status" },
          op: "EQUAL",
          value: { stringValue: "searching" }
        }
      }
    }
  };

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + accessToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error("Firestore REST error " + response.status + ": " + text.slice(0, 500));
  }

  const rows = JSON.parse(text);
  const rides = rows
    .filter(row => row.document)
    .map(row => documentToRide(row.document));

  console.log("Firestore returned", rides.length, "searching ride(s).");
  return rides;
}

async function getDriverTokens(accessToken) {
  console.log("Reading driver FCM tokens...");
  const response = await fetchWithTimeout(
    DATABASE_URL + "/drivers.json",
    {
      headers: {
        Accept: "application/json",
        Authorization: "Bearer " + accessToken
      }
    }
  );

  const text = await response.text();
  if (!response.ok) {
    throw new Error("Realtime Database REST error " + response.status + ": " + text.slice(0, 500));
  }

  const drivers = text && text !== "null" ? JSON.parse(text) : {};
  const tokens = [];

  for (const [driverId, driver] of Object.entries(drivers || {})) {
    const token = driver?.fcmToken;
    if (typeof token === "string" && token.trim()) {
      tokens.push({ driverId, token: token.trim() });
    }
  }

  console.log("Driver FCM tokens found:", tokens.length);
  return tokens;
}

async function sendNotification(accessToken, ride, token) {
  const rideType = ride.rideType === "reserve" ? "Reserve Ride" : "Share Ride";
  const from = ride.from || "Pickup Point";
  const to = ride.to || "Drop Point";

  const message = {
    message: {
      token,
      notification: {
        title: "🔔 নতুন Booking এসেছে",
        body: rideType + ": " + from + " → " + to
      },
      data: {
        rideId: String(ride.id),
        type: "new_booking",
        rideType: String(ride.rideType || "share")
      },
      webpush: {
        notification: {
          title: "🔔 নতুন Booking এসেছে",
          body: rideType + ": " + from + " → " + to
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
  if (!response.ok) {
    return { ok: false, status: response.status, text };
  }
  return { ok: true, status: response.status };
}

async function main() {
  console.log("Notification worker started.");
  const lastRun = readLastRun();
  const now = new Date();
  console.log("Looking for rides created after:", lastRun.toISOString());

  const accessToken = await getAccessToken();
  const allRides = await getSearchingRides(accessToken);

  const rides = allRides.filter(ride => {
    const created = ride.createdAt instanceof Date
      ? ride.createdAt
      : new Date(ride.createdAt);
    return !Number.isNaN(created.getTime()) && created > lastRun && created <= now;
  });

  console.log("New rides to notify:", rides.length);

  const drivers = await getDriverTokens(accessToken);

  for (const ride of rides) {
    console.log("Sending notification for ride", ride.id, "to", drivers.length, "driver(s)...");
    for (const driver of drivers) {
      try {
        const result = await sendNotification(accessToken, ride, driver.token);
        if (result.ok) {
          console.log("Notification sent successfully to driver", driver.driverId);
        } else {
          console.log("Notification failed for driver", driver.driverId,
            "HTTP", result.status, result.text.slice(0, 300));
        }
      } catch (error) {
        console.log("Notification request error for driver", driver.driverId, error.message);
      }
    }
  }

  writeLastRun(now);
  console.log("Notification check completed successfully.");
}

main().catch(error => {
  console.error("Notification worker failed:", error);
  process.exit(1);
});
