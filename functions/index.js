// File: functions/index.js

// Import necessary modules
const functions = require("firebase-functions"); // Firebase Functions SDK
const Razorpay = require("razorpay"); // Razorpay Node.js SDK
const cors = require("cors")({ origin: true }); // CORS middleware for HTTP requests
const crypto = require("crypto"); // Node.js crypto for signature verification
const admin = require("firebase-admin"); // Firebase Admin SDK

// Initialize Firebase Admin SDK ONCE at the top level
// This allows interaction with Firestore from backend functions
try {
    admin.initializeApp();
} catch (e) {
    // Log if initialization is skipped (e.g., in testing environments) or fails
    console.log("Admin SDK init skipped or failed:", e);
}
// Get Firestore instance from Admin SDK
const db = admin.firestore();

// --- createRazorpayOrder Function ---
// HTTP endpoint to securely create a Razorpay Order ID on the server.
exports.createRazorpayOrder = functions.https.onRequest((request, response) => {
  // Use cors middleware to handle preflight OPTIONS requests and add CORS headers
  cors(request, response, async () => {
    console.log("Function execution started (createRazorpayOrder). Method:", request.method);

    let razorpayInstance;
    let initError = null;

    // Initialize Razorpay instance using keys stored securely in environment variables
    try {
        console.log("Attempting to load Razorpay keys from process.env...");
        const razorpayKeyId = process.env.RAZORPAY_KEY_ID;
        const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET;
        console.log("Loaded Key ID from env:", razorpayKeyId ? "Exists" : "MISSING!");
        console.log("Loaded Key Secret from env:", razorpayKeySecret ? "Exists" : "MISSING!");

        // Throw error if keys are not configured in the function's environment
        if (!razorpayKeyId || !razorpayKeySecret) {
            throw new Error("Razorpay Key ID or Key Secret not found in function environment variables.");
        }

        // Create Razorpay instance
        razorpayInstance = new Razorpay({ key_id: razorpayKeyId, key_secret: razorpayKeySecret });
         console.log("Razorpay instance initialized successfully using env vars.");

    } catch (error) {
        // Log initialization errors and prepare error message
        console.error("Razorpay initialization failed RAW:", error);
        initError = "Configuration error on server. Check function logs.";
    }

    // Only allow POST requests for creating orders
    if (request.method !== "POST") {
       console.log(`Method ${request.method} not allowed.`);
       if (request.method !== 'OPTIONS') { // OPTIONS is handled by CORS middleware
           response.set('Allow', 'POST');
           return response.status(405).send({ error: "Method Not Allowed" });
       }
       return; // Let CORS handle OPTIONS response
    }

    // Check if required data is present in the request body
    console.log("Received request body:", request.body);
    if (!request.body || !request.body.amount || !request.body.currency || !request.body.receipt) {
      console.error("Missing required fields in request body.");
      return response.status(400).send({ error: "Missing required fields: amount, currency, receipt" });
    }

    // Return error if Razorpay initialization failed earlier
    if (initError) {
         console.error("Returning 500 due to initialization error:", initError);
         return response.status(500).send({ error: initError });
    }

    // Extract data from request body
    const { amount, currency, receipt } = request.body;

    // Validate the amount received (must be positive integer in smallest currency unit)
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
         console.error("Invalid amount (paise) received:", amount);
         return response.status(400).send({ error: "Invalid amount provided (must be positive integer in paise)." });
    }

    // Prepare options for Razorpay order creation API
    const options = {
      amount: amount, // Amount in paise received from client (amountBuyerPays)
      currency: currency,
      receipt: receipt, // Unique receipt ID (using dealId from client)
      notes: { dealId: receipt }, // Add dealId to notes for reference
    };
    console.log("Attempting to create Razorpay order with options:", options);

    // Call Razorpay API to create the order
    try {
      const order = await razorpayInstance.orders.create(options);
      console.log("Razorpay order created successfully:", order);
      // Send the generated order details back to the client
      return response.status(200).send({ orderId: order.id, amount: order.amount, currency: order.currency });
    } catch (error) {
      // Handle errors during Razorpay order creation
      console.error("Error creating Razorpay order RAW:", error);
      const errorMessage = error.error?.description || error.message || "Failed to create Razorpay order.";
      const statusCode = error.statusCode || 500;
      return response.status(statusCode).send({ error: errorMessage });
    }
  }); // End of cors wrapper
}); // End of createRazorpayOrder function


// --- verifyRazorpayPayment Function ---
// HTTP endpoint to securely verify Razorpay payment signature on the server.
exports.verifyRazorpayPayment = functions.https.onRequest((request, response) => {
  // Use cors middleware
  cors(request, response, async () => {
      console.log("Function execution started (verifyRazorpayPayment). Method:", request.method);

      // 1. Check Request Method and Body
      if (request.method !== "POST") { return response.status(405).send({ error: "Method Not Allowed" }); }
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature, dealId } = request.body;
      console.log("Received verification data:", { razorpay_order_id, razorpay_payment_id, signature_present: !!razorpay_signature, dealId });
      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !dealId) {
          console.error("Missing required fields for verification:", request.body);
          return response.status(400).send({ error: "Missing required payment verification details or dealId." });
      }

      // 2. Load Razorpay Secret Key
      const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET;
      if (!razorpayKeySecret) {
           console.error("Razorpay Key Secret not found in function environment variables for verification.");
           return response.status(500).send({ error: "Server configuration error." });
      }

      // 3. Verify Signature
      try {
          const body = razorpay_order_id + "|" + razorpay_payment_id;
          // Generate expected signature using HMAC-SHA256
          const expectedSignature = crypto
              .createHmac("sha256", razorpayKeySecret)
              .update(body.toString())
              .digest("hex");

          console.log("Expected Signature:", expectedSignature);
          console.log("Received Signature:", razorpay_signature);

          // Compare signatures securely
          if (crypto.timingSafeEqual(Buffer.from(expectedSignature, 'hex'), Buffer.from(razorpay_signature, 'hex'))) {
              // Signature matches - Payment is genuine
              console.log("Payment signature verified successfully for deal:", dealId);

              // 4. Update Firestore Deal Status (if signature is valid)
              try {
                  const dealDocRef = db.collection("deals").doc(dealId);
                  // Update status and record payment details
                  await dealDocRef.update({
                      status: 'payment_received',
                      paymentId: razorpay_payment_id,
                      paymentOrderId: razorpay_order_id,
                      paidAt: admin.firestore.FieldValue.serverTimestamp() // Use Admin SDK timestamp
                  });
                  console.log("Firestore status updated to payment_received for deal:", dealId);
                  // Send success response to client
                  return response.status(200).send({ success: true, message: "Payment verified and status updated." });

              } catch (firestoreError) {
                  console.error("Firestore update failed after successful verification:", firestoreError);
                   return response.status(500).send({ error: "Payment verified but failed to update deal status. Please contact support." });
              }

          } else {
              // Signature does not match
              console.warn("Payment signature verification failed for deal:", dealId);
              return response.status(400).send({ error: "Invalid payment signature." });
          }
      } catch (error) {
          console.error("Error during payment verification process:", error);
          return response.status(500).send({ error: "Payment verification failed due to server error." });
      }
  }); // End cors wrapper
}); // End verifyRazorpayPayment function


// --- triggerSellerPayout Function (Firestore Trigger - Deferred Implementation) ---
// This function will trigger when a deal status becomes 'completed'.
// It needs to fetch seller fund account ID and initiate Razorpay Payout.
/*
exports.triggerSellerPayout = functions.firestore
    .document('deals/{dealId}')
    .onUpdate(async (change, context) => {
        const dealId = context.params.dealId;
        const beforeData = change.before.data();
        const afterData = change.after.data();

        // Check if status changed TO 'completed'
        if (beforeData.status !== 'completed' && afterData.status === 'completed') {
            console.log(`Deal ${dealId} completed. Initiating payout process.`);

            const sellerUid = afterData.sellerUid;
            // Use amountSellerReceives from the deal document
            const amountToPayout = afterData.amountSellerReceives;
            const currency = afterData.currency || 'INR';

            if (!sellerUid || !amountToPayout || amountToPayout <= 0) {
                console.error(`Deal ${dealId}: Missing sellerUid or invalid amountSellerReceives for payout.`);
                // Optionally update deal status to 'payout_failed'
                return null;
            }

            // 1. Initialize Razorpay Instance (using env vars)
            // ... (similar init logic as createOrder) ...
            let razorpayInstance;
            // ... check keys and initialize ...
            if (!razorpayInstance) return null; // Exit if init fails

            // 2. Fetch Seller's Fund Account ID from users/{sellerUid}
            let fundAccountId;
            try {
                const userDocRef = db.collection('users').doc(sellerUid);
                const userDocSnap = await userDocRef.get();
                if (!userDocSnap.exists()) throw new Error(`Seller user doc ${sellerUid} not found.`);
                fundAccountId = userDocSnap.data()?.bankDetails?.fundAccountId;
                if (!fundAccountId || !fundAccountId.startsWith('fa_')) throw new Error(`Valid Razorpay Fund Account ID not found for seller ${sellerUid}.`);
                console.log(`Found Fund Account ID ${fundAccountId} for seller ${sellerUid}.`);
            } catch (userError) {
                 console.error(`Deal ${dealId}: Error fetching seller fund account ID:`, userError);
                 // Update deal status to 'payout_failed'
                 await db.collection('deals').doc(dealId).update({ status: 'payout_failed', payoutError: `Seller Fund Account ID Error: ${userError.message}` });
                 return null;
            }

            // 3. Create Razorpay Payout
            const payoutAmountInPaise = Math.round(amountToPayout * 100);
            const payoutData = {
                account_number: fundAccountId, // Use the fetched Fund Account ID
                fund_account_id: fundAccountId,
                amount: payoutAmountInPaise,
                currency: currency,
                mode: "IMPS", // Or NEFT/UPI
                purpose: "payout",
                queue_if_low_balance: true,
                notes: { deal_id: dealId, seller_uid: sellerUid, reason: "SecureSwap Deal Payout" }
            };
            console.log(`Deal ${dealId}: Attempting payout with data:`, payoutData);
            try {
                const payout = await razorpayInstance.payouts.create(payoutData);
                console.log(`Deal ${dealId}: Payout initiated successfully:`, payout);
                await db.collection('deals').doc(dealId).update({
                    status: 'payout_initiated', // Or map payout.status
                    payoutId: payout.id,
                    payoutStatus: payout.status,
                    payoutInitiatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            } catch (payoutError) {
                console.error(`Deal ${dealId}: Error creating Razorpay payout:`, payoutError);
                await db.collection('deals').doc(dealId).update({
                    status: 'payout_failed',
                    payoutError: payoutError.error?.description || payoutError.message || "Unknown payout error",
                    payoutFailedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            }
        } else {
            console.log(`Deal ${dealId}: Status changed to ${afterData.status}, no payout action needed.`);
            return null;
        }
        return null;
    });
*/

