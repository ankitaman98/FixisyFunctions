import {onCall, HttpsError} from "firebase-functions/v2/https";
import {log} from "firebase-functions/logger";
import {initializeApp} from "firebase-admin/app";
import {getAuth} from "firebase-admin/auth";
import {getFirestore, FieldValue} from "firebase-admin/firestore";
import {getMessaging} from "firebase-admin/messaging";
import apn from "apn";

initializeApp();
const db = getFirestore(); // Initialize Firestore instance

/**
 * Checks if a token is an APNs token (64 hex chars, no colons, no spaces).
 * @param {string} token
 * @return {boolean}
 */
function isApnsToken(token) {
  return /^[a-f0-9]{64}$/i.test(token);
}

export const createStaffUser = onCall(async (request) => {
  log("DEBUG: request.auth:", request.auth);
  log("DEBUG: request.data:", request.data);
  if (!request.auth) {
    log("DEBUG: Not authenticated!");
    throw new HttpsError("unauthenticated", "Request not authenticated", {
      auth: request.auth,
    });
  }
  const {email, password, name, mobile, permissions, businessId} =
    request.data;
  try {
    // 1. Create Auth user
    const userRecord = await getAuth().createUser({
      email,
      password,
      displayName: name,
    });
    // 2. Add staff profile to Firestore
    await db.collection("users").doc(userRecord.uid).set({
      uid: userRecord.uid,
      email,
      name,
      mobile,
      permissions,
      role: "staff",
      businessId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      active: true,
    });
    return {success: true};
  } catch (error) {
    log("DEBUG: Error in createStaffUser:", error.message);
    throw new HttpsError("internal", error.message, {auth: request.auth});
  }
});

export const deleteStaffUser = onCall(async (request) => {
  log("DEBUG: request.auth:", request.auth);
  log("DEBUG: request.data:", request.data);
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Request not authenticated", {
      auth: request.auth,
    });
  }
  const {staffUid} = request.data;
  try {
    // 1. Delete Auth user
    await getAuth().deleteUser(staffUid);
    // 2. Delete Firestore profile
    await db.collection("users").doc(staffUid).delete();
    return {success: true};
  } catch (error) {
    log("DEBUG: Error in deleteStaffUser:", error.message);
    throw new HttpsError("internal", error.message);
  }
});

export const sendBroadcastNotification = onCall(async (request) => {
  log("DEBUG: request.auth:", request.auth);
  log("DEBUG: request.data:", request.data);

  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Request not authenticated", {
      auth: request.auth,
    });
  }

  const {businessId, title, message, imageUrl, data} = request.data;

  if (!businessId || !title || !message) {
    throw new HttpsError(
        "invalid-argument",
        "businessId,title,and message are required",
    );
  }

  try {
    const repairsRef = db.collection("repairs");
    const repairsSnapshot = await repairsRef
        .where("businessId", "==", businessId)
        .get();

    log(
        "DEBUG: Found repairs for business:",
        businessId,
        "Count:",
        repairsSnapshot.size,
    );

    const uniqueMobileNumbers = new Set();
    repairsSnapshot.forEach((doc) => {
      const repairData = doc.data();
      log("DEBUG: Repair data:", {
        repairId: doc.id,
        customerMobile: repairData.customerMobile,
        businessId: repairData.businessId,
      });
      if (repairData.customerMobile) {
        uniqueMobileNumbers.add(repairData.customerMobile);
      }
    });

    log("DEBUG: Unique mobile numbers found:", Array.from(uniqueMobileNumbers));

    if (uniqueMobileNumbers.size === 0) {
      log("DEBUG: No customers found in repairs for business:", businessId);
      return {
        success: true,
        message: "No customers found in repairs",
        totalTokens: 0,
        totalSuccess: 0,
        totalFailure: 0,
      };
    }

    // Get FCM tokens for these mobile numbers from users collection
    const tokens = [];
    const usersRef = db.collection("users");

    for (const mobileNumber of uniqueMobileNumbers) {
      try {
        log("DEBUG: Looking for user with mobile:", mobileNumber);
        const userQuery = await usersRef
            .where("mobile", "==", mobileNumber)
            .where("role", "==", "user")
            .get();

        log(
            "DEBUG: Found users for mobile:",
            mobileNumber,
            "Count:",
            userQuery.size,
        );

        if (!userQuery.empty) {
          userQuery.docs.forEach((doc) => {
            const userData = doc.data();
            log("DEBUG: User data for mobile:", mobileNumber, {
              hasFcmToken: !!userData.fcmToken,
              hasFcmTokens: Array.isArray(userData.fcmTokens),
              fcmTokensLength: Array.isArray(userData.fcmTokens) ?
                userData.fcmTokens.length :
                0,
            });
            // Support both array and legacy string
            if (Array.isArray(userData.fcmTokens)) {
              userData.fcmTokens.forEach((token) => {
                if (typeof token === "string" && token.length > 0) {
                  tokens.push(token);
                }
              });
            } else if (userData.fcmToken) {
              tokens.push(userData.fcmToken);
            }
          });
        } else {
          log("DEBUG: No user found for mobile:", mobileNumber);
        }
      } catch (error) {
        log(
            "DEBUG: Error fetching user for mobile:",
            mobileNumber,
            error.message,
        );
      }
    }

    // Split tokens into FCM and APNs tokens
    const fcmTokens = tokens.filter((t) => !isApnsToken(t));
    const apnsTokens = tokens.filter(isApnsToken);

    if (fcmTokens.length === 0 && apnsTokens.length === 0) {
      log("DEBUG: No FCM or APNs tokens found for customers:", businessId);
      return {
        success: true,
        message: "No customers found with FCM or APNs tokens",
        totalTokens: 0,
        totalSuccess: 0,
        totalFailure: 0,
      };
    }

    // Prepare notification payload (for FCM)
    const payload = {
      notification: {
        title: title,
        body: message,
        ...(imageUrl && {imageUrl: imageUrl}),
      },
      data: data || {},
      android: {
        priority: "high",
        notification: {
          sound: "default",
          priority: "high",
          ...(imageUrl && {imageUrl: imageUrl}),
        },
      },
      apns: {
        payload: {
          aps: {sound: "default", ...(imageUrl && {"mutable-content": 1})},
          ...(imageUrl && {fcm_options: {image: imageUrl}}),
        },
      },
    };

    // Send FCM notifications in batches (FCM limit is 500 tokens per request)
    const batchSize = 500;
    const results = [];
    let totalSuccess = 0;
    let totalFailure = 0;

    for (let i = 0; i < fcmTokens.length; i += batchSize) {
      const batch = fcmTokens.slice(i, i + batchSize);
      try {
        const multicastMessage = {tokens: batch, ...payload};
        const response = await getMessaging().sendEachForMulticast(
            multicastMessage,
        );
        results.push({
          batch: Math.floor(i / batchSize) + 1,
          type: "FCM",
          successCount: response.successCount,
          failureCount: response.failureCount,
          responses: response.responses,
        });
        totalSuccess += response.successCount;
        totalFailure += response.failureCount;
      } catch (error) {
        log("DEBUG: Error sending FCM batch:", error.message);
        results.push({
          batch: Math.floor(i / batchSize) + 1,
          type: "FCM",
          error: error.message,
        });
      }
    }

    // Send APNs notifications if there are APNs tokens
    if (apnsTokens.length > 0) {
      log("DEBUG: Sending APNs notifications", {
        apnsTokenCount: apnsTokens.length,
        title,
        message,
        imageUrl,
        data,
      });
      // APNs provider setup (replace with your credentials)
      const apnProvider = new apn.Provider({
        token: {
          key: "./AuthKey_G3U784978F.p8",
          keyId: "G3U784978F",
          teamId: "PWZNNKGGN3",
        },
        production: true,
      });
      const apnNotification = new apn.Notification();
      apnNotification.alert = {title, body: message};
      apnNotification.sound = "default";
      apnNotification.topic = "com.ankit.aman.Fixisy";
      // if (imageUrl) {
      //   apnNotification.mutableContent = 1;
      //   apnNotification.aps = {"mutable-content": 1};
      //   apnNotification.payload = {
      //     ...(apnNotification.payload || {}),
      //     imageUrl,
      //   };
      // }
      if (data) {
        apnNotification.payload = {
          ...(apnNotification.payload || {}),
          ...data,
        };
      }
      // Send APNs notifications in batches (max 1000 per batch is safe)
      for (let i = 0; i < apnsTokens.length; i += 1000) {
        const batch = apnsTokens.slice(i, i + 1000);
        log("DEBUG: Sending APNs batch", {
          batchNumber: Math.floor(i / 1000) + 1,
          batchSize: batch.length,
          notificationPayload: apnNotification,
        });
        try {
          const response = await apnProvider.send(apnNotification, batch);
          log("DEBUG: APNs batch response", {
            batchNumber: Math.floor(i / 1000) + 1,
            sent: response.sent.length,
            failed: response.failed.length,
            failedDetails: response.failed,
          });
          if (response.failed && response.failed.length > 0) {
            response.failed.forEach((fail, idx) => {
              log("APNs failure detail", {
                batch: Math.floor(i / 1000) + 1,
                index: idx,
                device: fail.device,
                status: fail.status,
                response: fail.response,
                error: fail.error,
                full: JSON.stringify(fail),
              });
            });
          }
          results.push({
            batch: Math.floor(i / 1000) + 1,
            type: "APNs",
            sent: response.sent.length,
            failed: response.failed.length,
            details: response.failed,
          });
          totalSuccess += response.sent.length;
          totalFailure += response.failed.length;
        } catch (error) {
          log("DEBUG: Error sending APNs batch:", error.message);
          results.push({
            batch: Math.floor(i / 1000) + 1,
            type: "APNs",
            error: error.message,
          });
        }
      }
      apnProvider.shutdown();
    }

    log("DEBUG: Broadcast notification sent successfully:", {
      totalTokens: tokens.length,
      totalSuccess,
      totalFailure,
      results,
    });

    return {
      success: true,
      message:
        `Notification sent to ${totalSuccess} devices` +
        (apnsTokens.length > 0 ? " (includes APNs)" : ""),
      totalTokens: tokens.length,
      totalSuccess,
      totalFailure,
      results,
    };
  } catch (error) {
    log("DEBUG: Error in sendBroadcastNotification:", error.message);
    throw new HttpsError("internal", error.message);
  }
});

/**
 * Sends a status update notification to a user by mobile number.
 * Supports both FCM and APNs tokens, with image and data payloads.
 * @param {object} request
 * @return {Promise<object>}
 */
export const sendStatusUpdate = onCall(async (request) => {
  log("DEBUG: sendNotificationByMobile called. request.auth:", request.auth);
  log("DEBUG: sendNotificationByMobile called. request.data:", request.data);
  if (!request.auth) {
    log("DEBUG: Not authenticated!");
    return {
      success: false,
      error: "Request not authenticated",
    };
  }

  const {mobile, title, message, imageUrl, data} = request.data;
  log("DEBUG: Extracted params", {mobile, title, message, imageUrl, data});

  if (!mobile || !title || !message) {
    log("DEBUG: Missing required fields", {mobile, title, message});
    return {
      success: false,
      error: "Missing required fields",
    };
  }

  try {
    // Query Firestore for user with this mobile number
    const usersRef = db.collection("users");
    log("DEBUG: Querying users collection for mobile:", mobile);
    const snapshot = await usersRef.where("mobile", "==", mobile).get();

    if (snapshot.empty) {
      log("DEBUG: No user found with this mobile number:", mobile);
      return {
        success: false,
        error: "No user found with this mobile number",
      };
    }

    // Collect all tokens for all users with this mobile
    const tokens = [];
    snapshot.docs.forEach((doc) => {
      const userData = doc.data();
      log("DEBUG: User data for mobile:", mobile, {
        hasFcmToken: !!userData.fcmToken,
        hasFcmTokens: Array.isArray(userData.fcmTokens),
        fcmTokensLength: Array.isArray(userData.fcmTokens) ?
          userData.fcmTokens.length :
          0,
      });
      if (Array.isArray(userData.fcmTokens)) {
        userData.fcmTokens.forEach((token) => {
          if (typeof token === "string" && token.length > 0) {
            tokens.push(token);
          }
        });
      } else if (userData.fcmToken) {
        tokens.push(userData.fcmToken);
      }
    });

    log("DEBUG: Tokens found for mobile:", tokens);

    // Split tokens into FCM and APNs tokens
    const fcmTokens = tokens.filter((t) => !isApnsToken(t));
    const apnsTokens = tokens.filter(isApnsToken);

    if (fcmTokens.length === 0 && apnsTokens.length === 0) {
      log("DEBUG: No FCM or APNs tokens found for this user:", mobile);
      return {
        success: false,
        error: "No FCM or APNs tokens found for this user",
      };
    }

    // Prepare notification payload (for FCM)
    const payload = {
      notification: {
        title: title,
        body: message,
        ...(imageUrl && {imageUrl: imageUrl}),
      },
      android: {
        priority: "high",
        notification: {
          sound: "default",
          priority: "high",
        },
      },
      apns: {
        payload: {
          aps: {sound: "default", ...(imageUrl && {"mutable-content": 1})},
          ...(imageUrl && {fcm_options: {image: imageUrl}}),
        },
      },
      data: data || {},
    };
    log("DEBUG: Notification payload:", payload);

    // Send FCM notifications in batches (FCM limit is 500 tokens per request)
    const batchSize = 500;
    const results = [];
    let totalSuccess = 0;
    let totalFailure = 0;

    for (let i = 0; i < fcmTokens.length; i += batchSize) {
      const batch = fcmTokens.slice(i, i + batchSize);
      try {
        const multicastMessage = {tokens: batch, ...payload};
        const response = await getMessaging().sendEachForMulticast(
            multicastMessage,
        );
        results.push({
          batch: Math.floor(i / batchSize) + 1,
          type: "FCM",
          successCount: response.successCount,
          failureCount: response.failureCount,
          responses: response.responses,
        });
        totalSuccess += response.successCount;
        totalFailure += response.failureCount;
        log("DEBUG: FCM batch sent", {
          batch: Math.floor(i / batchSize) + 1,
          successCount: response.successCount,
          failureCount: response.failureCount,
        });
      } catch (error) {
        log("DEBUG: Error sending FCM batch:", error.message);
        results.push({
          batch: Math.floor(i / batchSize) + 1,
          type: "FCM",
          error: error.message,
        });
      }
    }

    // Send APNs notifications if there are APNs tokens
    if (apnsTokens.length > 0) {
      log("DEBUG: Sending APNs notifications", {
        apnsTokenCount: apnsTokens.length,
        title,
        message,
        imageUrl,
        data,
      });
      // APNs provider setup (replace with your credentials)
      const apnProvider = new apn.Provider({
        token: {
          key: "./AuthKey_G3U784978F.p8",
          keyId: "G3U784978F",
          teamId: "PWZNNKGGN3",
        },
        production: true,
      });
      const apnNotification = new apn.Notification();
      apnNotification.alert = {title, body: message};
      apnNotification.sound = "default";
      apnNotification.topic = "com.ankit.aman.Fixisy";
      if (imageUrl) {
        apnNotification.mutableContent = 1;
        apnNotification.aps = {"mutable-content": 1};
        apnNotification.payload = {
          ...(apnNotification.payload || {}),
          imageUrl,
        };
      }
      if (data) {
        apnNotification.payload = {
          ...(apnNotification.payload || {}),
          ...data,
        };
      }
      // Send APNs notifications in batches (max 1000 per batch is safe)
      for (let i = 0; i < apnsTokens.length; i += 1000) {
        const batch = apnsTokens.slice(i, i + 1000);
        log("DEBUG: Sending APNs batch", {
          batchNumber: Math.floor(i / 1000) + 1,
          batchSize: batch.length,
          notificationPayload: apnNotification,
        });
        try {
          const response = await apnProvider.send(apnNotification, batch);
          log("DEBUG: APNs batch response", {
            batchNumber: Math.floor(i / 1000) + 1,
            sent: response.sent.length,
            failed: response.failed.length,
            failedDetails: response.failed,
          });
          if (response.failed && response.failed.length > 0) {
            response.failed.forEach((fail, idx) => {
              log("APNs failure detail", {
                batch: Math.floor(i / 1000) + 1,
                index: idx,
                device: fail.device,
                status: fail.status,
                response: fail.response,
                error: fail.error,
                full: JSON.stringify(fail),
              });
            });
          }
          results.push({
            batch: Math.floor(i / 1000) + 1,
            type: "APNs",
            sent: response.sent.length,
            failed: response.failed.length,
            details: response.failed,
          });
          totalSuccess += response.sent.length;
          totalFailure += response.failed.length;
        } catch (error) {
          log("DEBUG: Error sending APNs batch:", error.message);
          results.push({
            batch: Math.floor(i / 1000) + 1,
            type: "APNs",
            error: error.message,
          });
        }
      }
      apnProvider.shutdown();
    }

    log("DEBUG: Notification sent. Summary:", {
      totalTokens: tokens.length,
      totalSuccess,
      totalFailure,
      results,
    });

    return {
      success: true,
      message:
        `Notification sent to ${totalSuccess} devices` +
        (apnsTokens.length > 0 ? " (includes APNs)" : ""),
      totalTokens: tokens.length,
      totalSuccess,
      totalFailure,
      results,
    };
  } catch (error) {
    log("DEBUG: Error in sendNotificationByMobile:", error.message, error);
    return {
      success: false,
      error: error.message || "Failed to send notification",
      details: error.stack,
    };
  }
});

export const signOutFromAllDevices = onCall(async (request) => {
  if (!request.auth) {
    return {success: false, error: "Request not authenticated"};
  }

  const uid = request.auth.uid;
  try {
    await getAuth().revokeRefreshTokens(uid);
    return {success: true, message: "User signed out from all devices."};
  } catch (error) {
    log("signOutFromAllDevices error:", error.message || error);
    return {
      success: false,
      error: error.message || "Failed to sign out from all devices.",
    };
  }
});
