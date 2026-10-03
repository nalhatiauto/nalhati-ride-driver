const admin = require("firebase-admin");
const fs = require("fs");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://nalhati-ride-default-rtdb.firebaseio.com"
});

const db = admin.firestore();
const rtdb = admin.database();
const messaging = admin.messaging();
const statePath = "notification-state.json";

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

async function main() {
  const lastRun = readLastRun();
  const now = new Date();

  console.log("Checking Firestore for new searching rides since:", lastRun.toISOString());
  const snapshot = await db.collection("rides").where("status", "==", "searching").get();
  console.log("Firestore returned", snapshot.size, "searching ride(s).");

  const rides = snapshot.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(ride => {
      const created = ride.createdAt?.toDate ? ride.createdAt.toDate() : new Date(ride.createdAt);
      return created > lastRun && created <= now;
    });

  console.log("New rides to notify:", rides.length);

  console.log("Reading driver FCM tokens...");
  const driversSnapshot = await rtdb.ref("drivers").get();
  const tokens = [];

  if (driversSnapshot.exists()) {
    driversSnapshot.forEach(driver => {
      const token = driver.child("fcmToken").val();
      if (typeof token === "string" && token.trim()) tokens.push(token.trim());
    });
  }

  console.log("Driver FCM tokens found:", tokens.length);

  if (rides.length && tokens.length) {
    for (const ride of rides) {
      const rideType = ride.rideType === "reserve" ? "Reserve Ride" : "Share Ride";
      const from = ride.from || "Pickup Point";
      const to = ride.to || "Drop Point";

      const messageBase = {
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
      };

      for (let i = 0; i < tokens.length; i += 500) {
        const chunk = tokens.slice(i, i + 500);
        console.log("Sending notification for ride", ride.id, "to", chunk.length, "token(s)...");
        const response = await messaging.sendEachForMulticast({
          ...messageBase,
          tokens: chunk
        });
        console.log("Notification result:", response.successCount, "success,", response.failureCount, "failed");

        const invalid = [];
        response.responses.forEach((result, index) => {
          if (!result.success) {
            const code = result.error?.code || "";
            if (code.includes("registration-token-not-registered") ||
                code.includes("invalid-registration-token")) {
              invalid.push(chunk[index]);
            }
          }
        });

        if (invalid.length) {
          const updates = {};
          driversSnapshot.forEach(driver => {
            const token = driver.child("fcmToken").val();
            if (invalid.includes(token)) updates[driver.key + "/fcmToken"] = null;
          });
          if (Object.keys(updates).length) await rtdb.ref("drivers").update(updates);
        }
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
