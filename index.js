const cors = require("cors");
const express = require("express");
const admin = require("firebase-admin");
const axios = require("axios");

const app = express();
app.use(cors({ origin: "*" }));

// Webhook ke liye raw body, baaki ke liye JSON
app.use((req, res, next) => {
  if (req.path === "/api/wallet/webhook") {
    express.raw({ type: "*/*" })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});

// ============================================
// FIREBASE SETUP
// ============================================
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY
        ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
        : undefined,
    }),
  });
}
const db = admin.firestore();

// ============================================
// TRANZUPI CONFIG
// KYC approve hone ke baad Vercel Environment
// Variables mein ye keys daalna
// ============================================
const TRANZUPI_API_KEY  = process.env.TRANZUPI_API_KEY || "APNI_KEY_YAHAN";
const TRANZUPI_SECRET   = process.env.TRANZUPI_SECRET  || "APNA_SECRET_YAHAN";
const TRANZUPI_BASE_URL = "https://tranzupi.com/api";

// ============================================
// ROUTE 0: Health Check
// ============================================
app.get("/", (req, res) => {
  res.send("Purnima E-Sports Backend Running! TranzUPI Ready.");
});

// ============================================
// ROUTE 1: ORDER CREATE (QR Generate)
// User Pay Now dabata hai to ye call hoti hai
// ============================================
app.post("/api/wallet/tranzupi/create", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const idToken = authHeader.split("Bearer ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid     = decoded.uid;

    const amount = parseInt(req.body.amount);
    if (!amount || amount < 10) {
      return res.status(400).json({ error: "Minimum amount Rs.10 required" });
    }

    const orderId = "PES_" + uid.substring(0, 6) + "_" + Date.now();

    const payload = {
      api_key:        TRANZUPI_API_KEY,
      order_id:       orderId,
      amount:         amount,
      currency:       "INR",
      purpose:        "Wallet Recharge - Purnima E-Sports",
      customer_name:  "Player",
      customer_email: decoded.email || "player@purnima.com",
      webhook_url:    "https://purnima-tranzupi-backend.vercel.app/api/wallet/webhook",
    };

    const response = await axios.post(
      `${TRANZUPI_BASE_URL}/create_order`,
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": TRANZUPI_API_KEY,
        },
        timeout: 15000,
      }
    );

    const data = response.data;

    // Pending order Firestore mein save karo
    await db.collection("pending_orders").doc(orderId).set({
      uid:       uid,
      amount:    amount,
      orderId:   orderId,
      status:    "pending",
      createdAt: Date.now(),
    });

    res.json({
      success:     true,
      order_id:    orderId,
      payment_url: data.payment_url || data.qr_url || data.url  || null,
      qr_data:     data.qr_data     || data.upi_qr || null,
      upi_id:      data.upi_id      || data.vpa    || null,
    });

  } catch (err) {
    console.error("Create Order Error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ============================================
// ROUTE 2: CHECK PAYMENT STATUS (Manual)
// User I Have Paid dabata hai to ye call hoti hai
// ============================================
app.post("/api/wallet/tranzupi/check", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const idToken = authHeader.split("Bearer ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid     = decoded.uid;

    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ error: "order_id required" });

    const response = await axios.post(
      `${TRANZUPI_BASE_URL}/check_order`,
      { api_key: TRANZUPI_API_KEY, order_id: order_id },
      { headers: { "x-api-key": TRANZUPI_API_KEY }, timeout: 10000 }
    );

    const data   = response.data;
    const status = data.status || data.payment_status || "";

    if (
      status === "SUCCESS"   ||
      status === "PAID"      ||
      status === "Credit"    ||
      status === "Completed"
    ) {
      await creditWallet(uid, order_id);
      return res.json({ status: "SUCCESS" });
    }

    res.json({ status: status || "PENDING" });

  } catch (err) {
    console.error("Check Order Error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ============================================
// ROUTE 3: WEBHOOK (TranzUPI automatic call)
// Payment hote hi TranzUPI ye URL call karta hai
// Dashboard mein ye URL daalni hai:
// https://purnima-tranzupi-backend.vercel.app/api/wallet/webhook
// ============================================
app.post("/api/wallet/webhook", async (req, res) => {
  try {
    let body;
    if (Buffer.isBuffer(req.body)) {
      body = JSON.parse(req.body.toString());
    } else {
      body = req.body;
    }

    console.log("Webhook received:", JSON.stringify(body));

    const status   = body.status   || body.payment_status || "";
    const order_id = body.order_id || body.orderId        || "";

    if (!order_id) {
      return res.status(400).json({ error: "order_id missing" });
    }

    // Firestore se pending order uthao
    const orderDoc = await db.collection("pending_orders").doc(order_id).get();
    if (!orderDoc.exists) {
      return res.status(404).json({ error: "Order not found" });
    }

    const uid = orderDoc.data().uid;

    if (
      status === "SUCCESS"   ||
      status === "PAID"      ||
      status === "Credit"    ||
      status === "Completed"
    ) {
      await creditWallet(uid, order_id);
    }

    res.status(200).json({ received: true });

  } catch (err) {
    console.error("Webhook Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// ROUTE 4: VERIFY ORDER (App wapas aane par)
// ============================================
app.post("/api/wallet/verifyOrder", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const idToken = authHeader.split("Bearer ")[1];
    await admin.auth().verifyIdToken(idToken);

    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: "orderId required" });

    const orderDoc = await db.collection("pending_orders").doc(orderId).get();
    if (!orderDoc.exists) return res.json({ status: "NOT_FOUND" });

    const orderData = orderDoc.data();
    if (orderData.status === "paid") return res.json({ status: "PAID" });

    res.json({ status: "PENDING" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// HELPER: WALLET CREDIT (Sirf ek baar hoga)
// ============================================
async function creditWallet(uid, orderId) {
  const orderRef = db.collection("pending_orders").doc(orderId);
  const orderDoc = await orderRef.get();

  if (!orderDoc.exists) return;
  const orderData = orderDoc.data();

  // Already processed check - double credit nahi hoga
  if (orderData.status === "paid") {
    console.log("Already credited:", orderId);
    return;
  }

  const amount = orderData.amount;

  // Firebase wallet update
  await db.collection("users").doc(uid).update({
    balance: admin.firestore.FieldValue.increment(amount),
    transactions: admin.firestore.FieldValue.arrayUnion({
      type:   "credit",
      amount: amount,
      msg:    "Wallet Recharge (UPI)",
      date:   Date.now(),
    }),
  });

  // Order paid mark karo
  await orderRef.update({ status: "paid", paidAt: Date.now() });

  console.log(`Wallet credited: UID=${uid}, Amount=${amount}, Order=${orderId}`);
}

module.exports = app;
