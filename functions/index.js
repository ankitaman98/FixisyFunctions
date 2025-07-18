import {onCall, HttpsError} from "firebase-functions/v2/https";
import {log} from "firebase-functions/logger";
import {initializeApp} from "firebase-admin/app";
import {getAuth} from "firebase-admin/auth";
import {getFirestore, FieldValue} from "firebase-admin/firestore";
import {getMessaging} from "firebase-admin/messaging";

initializeApp();
const db = getFirestore(); // Initialize Firestore instance

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

    if (tokens.length === 0) {
      log("DEBUG: No FCM tokens found for customers:", businessId);
      return {
        success: true,
        message: "No customers found with FCM tokens",
        totalTokens: 0,
        totalSuccess: 0,
        totalFailure: 0,
      };
    }

    // Prepare notification payload
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

    // Send notifications in batches (FCM limit is 500 tokens per request)
    const batchSize = 500;
    const results = [];

    for (let i = 0; i < tokens.length; i += batchSize) {
      const batch = tokens.slice(i, i + batchSize);

      try {
        // Construct the multicast message with the tokens and payload
        const multicastMessage = {tokens: batch, ...payload};

        // Use sendEachForMulticast for sending to multiple tokens
        const response = await getMessaging().sendEachForMulticast(
            multicastMessage,
        );
        results.push({
          batch: Math.floor(i / batchSize) + 1,
          successCount: response.successCount,
          failureCount: response.failureCount,
          responses: response.responses,
        });
      } catch (error) {
        log("DEBUG: Error sending batch:", error.message);
        results.push({
          batch: Math.floor(i / batchSize) + 1,
          error: error.message,
        });
      }
    }

    const totalSuccess = results.reduce(
        (sum, result) => sum + (result.successCount || 0),
        0,
    );
    const totalFailure = results.reduce(
        (sum, result) => sum + (result.failureCount || 0),
        0,
    );

    log("DEBUG: Broadcast notification sent successfully:", {
      totalTokens: tokens.length,
      totalSuccess,
      totalFailure,
      results,
    });

    return {
      success: true,
      message: `Notification sent to ${totalSuccess} devices`,
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

  const {mobile, title, message} = request.data;
  log("DEBUG: Extracted params", {mobile, title, message});

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

    log("DEBUG: FCM tokens found for mobile:", tokens);

    if (tokens.length === 0) {
      log("DEBUG: No FCM tokens found for this user:", mobile);
      return {
        success: false,
        error: "No FCM tokens found for this user",
      };
    }

    // Prepare notification payload (no image, no data)
    const payload = {
      notification: {
        title: title,
        body: message,
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
          aps: {sound: "default"},
        },
      },
    };
    log("DEBUG: Notification payload:", payload);

    // Send notifications in batches (FCM limit is 500 tokens per request)
    const batchSize = 500;
    const results = [];

    for (let i = 0; i < tokens.length; i += batchSize) {
      const batch = tokens.slice(i, i + batchSize);
      try {
        const multicastMessage = {tokens: batch, ...payload};
        const response =
        await getMessaging().sendEachForMulticast(multicastMessage);
        results.push({
          batch: Math.floor(i / batchSize) + 1,
          successCount: response.successCount,
          failureCount: response.failureCount,
          responses: response.responses,
        });
        log("DEBUG: Batch sent", {
          batch: Math.floor(i / batchSize) + 1,
          successCount: response.successCount,
          failureCount: response.failureCount,
        });
      } catch (error) {
        log("DEBUG: Error sending batch:", error.message, error);
        results.push({
          batch: Math.floor(i / batchSize) + 1,
          error: error.message,
        });
      }
    }

    const totalSuccess = results.reduce((sum, result) =>
      sum + (result.successCount || 0), 0);
    const totalFailure = results.reduce((sum, result) =>
      sum + (result.failureCount || 0), 0);

    log("DEBUG: Notification sent. Summary:", {
      totalTokens: tokens.length,
      totalSuccess,
      totalFailure,
      results,
    });

    return {
      success: true,
      message: `Notification sent to ${totalSuccess} devices`,
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
