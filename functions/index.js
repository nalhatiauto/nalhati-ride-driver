const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp({
  databaseURL: "https://nalhati-ride-default-rtdb.firebaseio.com"
});

const rtdb = getDatabase();

exports.notifyDriverOnNewBooking = onDocumentCreated(
  {
    document: "rides/{rideId}",
    region: "asia-south1"
  },
  async (event) => {
    const ride = event.data?.data();
    if (!ride || ride.status !== "searching") return;

    const rideId = event.params.rideId;
    const tokensSnapshot = await rtdb.ref("drivers").get();
    if (!tokensSnapshot.exists()) return;

    const tokens = [];
    tokensSnapshot.forEach((driverSnapshot) => {
      const token = driverSnapshot.child("fcmToken").val();
      if (typeof token === "string" && token.trim()) tokens.push(token.trim());
    });
    if (!tokens.length) return;

    const rideType = ride.rideType === "reserve" ? "Reserve Ride" : "Share Ride";
    const from = ride.from || "Pickup Point";
    const to = ride.to || "Drop Point";

    const message = {
      notification: {
        title: "🔔 নতুন Booking এসেছে",
        body: rideType + ": " + from + " → " + to
      },
      data: {
        rideId: String(rideId),
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
      },
      tokens
    };

    const response = await getMessaging().sendEachForMulticast(message);

    const invalidTokens = [];
    response.responses.forEach((result, index) => {
      if (!result.success) {
        const code = result.error?.code || "";
        if (code.includes("registration-token-not-registered") ||
            code.includes("invalid-registration-token")) {
          invalidTokens.push(tokens[index]);
        }
      }
    });

    if (invalidTokens.length) {
      const updates = {};
      tokensSnapshot.forEach((driverSnapshot) => {
        const token = driverSnapshot.child("fcmToken").val();
        if (invalidTokens.includes(driverSnapshot.child("fcmToken").val())) {
          updates[driverSnapshot.key + "/fcmToken"] = null;
        }
      });
      if (Object.keys(updates).length) {
        await rtdb.ref("drivers").update(updates);
      }
    }

    console.log("New booking notification sent:", response.successCount, "success,", response.failureCount, "failed");
  }
);
