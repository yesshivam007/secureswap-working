// File: functions/index.js

const functions = require("firebase-functions");
const Razorpay = require("razorpay");
const cors = require("cors")({ origin: true });
const crypto = require("crypto"); // Import Node.js crypto module for verification
const admin = require("firebase-admin");

// Initialize Admin SDK ONLY ONCE at the top level
try {
    admin.initializeApp();
} catch (e) {
    console.log("Admin SDK already initialized or initialization failed:", e);
}
const db = admin.firestore(); // Get Firestore instance from Admin SDK


// --- createRazorpayOrder Function (No changes needed here) ---
exports.createRazorpayOrder = functions.https.onRequest((request, response) => {
  cors(request, response, async () => {
    console.log("Function execution started (createRazorpayOrder). Method:", request.method);
    let razorpayInstance;
    let initError = null;
    try {
        console.log("Attempting to load Razorpay keys from process.env...");
        const razorpayKeyId = process.env.RAZORPAY_KEY_ID;
        const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET;
        console.log("Loaded Key ID from env:", razorpayKeyId ? "Exists" : "MISSING!");
        console.log("Loaded Key Secret from env:", razorpayKeySecret ? "Exists" : "MISSING!");
        if (!razorpayKeyId || !razorpayKeySecret) {
            throw new Error("Razorpay Key ID or Key Secret not found in function environment variables.");
        }
        razorpayInstance = new Razorpay({ key_id: razorpayKeyId, key_secret: razorpayKeySecret });
         console.log("Razorpay instance initialized successfully using env vars.");
    } catch (error) { console.error("Razorpay initialization failed RAW:", error); initError = "Configuration error on server."; }

    if (request.method !== "POST") { /* ... handle non-POST ... */ return; }
    if (!request.body || !request.body.amount || !request.body.currency || !request.body.receipt) { /* ... handle missing fields ... */ return; }
    if (initError) { /* ... handle init error ... */ return response.status(500).send({ error: initError }); }

    const { amount, currency, receipt } = request.body;
    if (typeof amount !== 'number' || amount <= 0) { /* ... handle invalid amount ... */ return; }
    const options = { amount: Math.round(amount), currency: currency, receipt: receipt, notes: { dealId: receipt }, };
    console.log("Attempting to create Razorpay order with options:", options);
    try {
      const order = await razorpayInstance.orders.create(options);
      console.log("Razorpay order created successfully:", order);
      return response.status(200).send({ orderId: order.id, amount: order.amount, currency: order.currency });
    } catch (error) { console.error("Error creating Razorpay order RAW:", error); /* ... handle create error ... */ return; }
  });
});


// --- NEW: verifyRazorpayPayment Function ---
exports.verifyRazorpayPayment = functions.https.onRequest((request, response) => {
  // Use cors middleware
  cors(request, response, async () => {
      console.log("Function execution started (verifyRazorpayPayment). Method:", request.method);

      // 1. Check Request Method and Body
      if (request.method !== "POST") {
          return response.status(405).send({ error: "Method Not Allowed" });
      }
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature, dealId } = request.body;
      console.log("Received verification data:", { razorpay_order_id, razorpay_payment_id, signature_present: !!razorpay_signature, dealId });

      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !dealId) {
          console.error("Missing required fields for verification:", request.body);
          return response.status(400).send({ error: "Missing required payment verification details or dealId." });
      }

      // 2. Load Razorpay Secret Key (MUST be kept secret)
      const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET;
      if (!razorpayKeySecret) {
           console.error("Razorpay Key Secret not found in function environment variables for verification.");
           // Don't expose details, just a generic server error
           return response.status(500).send({ error: "Server configuration error." });
      }

      // 3. Verify Signature
      try {
          const body = razorpay_order_id + "|" + razorpay_payment_id;
          const expectedSignature = crypto
              .createHmac("sha256", razorpayKeySecret)
              .update(body.toString())
              .digest("hex");

          console.log("Expected Signature:", expectedSignature);
          console.log("Received Signature:", razorpay_signature);

          if (expectedSignature === razorpay_signature) {
              // Signature matches - Payment is genuine
              console.log("Payment signature verified successfully for deal:", dealId);

              // 4. Update Firestore Deal Status (if signature is valid)
              try {
                  const dealDocRef = db.collection("deals").doc(dealId);
                  // Optional: Fetch doc first to ensure status is still 'pending_payment' before updating
                  // const docSnap = await dealDocRef.get();
                  // if (docSnap.exists() && docSnap.data().status === 'pending_payment') { ... }

                  await dealDocRef.update({
                      status: 'payment_received', // Update status
                      paymentId: razorpay_payment_id,
                      paymentOrderId: razorpay_order_id, // Store order ID if needed
                      paidAt: admin.firestore.FieldValue.serverTimestamp() // Use Admin SDK timestamp
                  });
                  console.log("Firestore status updated to payment_received for deal:", dealId);
                  // Send success response to client
                  return response.status(200).send({ success: true, message: "Payment verified and status updated." });

              } catch (firestoreError) {
                  console.error("Firestore update failed after successful verification:", firestoreError);
                   // Important: Payment was successful but status update failed. Needs manual check or retry logic.
                   // Return an error indicating this specific issue.
                   return response.status(500).send({ error: "Payment verified but failed to update deal status. Please contact support." });
              }

          } else {
              // Signature does not match - Payment might be fraudulent
              console.warn("Payment signature verification failed for deal:", dealId);
              return response.status(400).send({ error: "Invalid payment signature." });
          }
      } catch (error) {
          console.error("Error during payment verification process:", error);
          return response.status(500).send({ error: "Payment verification failed due to server error." });
      }
  }); // End cors wrapper
}); // End function definition
