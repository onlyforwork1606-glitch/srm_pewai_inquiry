require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const { appendToSheet } = require("./sheets");

const app = express();
app.use(express.json());

const VERIFY_TOKEN    = process.env.WEBHOOK_VERIFY_TOKEN;
const ACCESS_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

// ──────────────────────────────────────────
// Auto-subscribe phone number to this app
// webhook every time the server starts
// ──────────────────────────────────────────
async function subscribeWebhook() {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.warn("⚠️  WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID not set — skipping");
    return;
  }
  try {
    const res = await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/subscribed_apps`,
      {},
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    console.log("✅ Phone number subscribed to webhook:", JSON.stringify(res.data));
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    console.error("❌ Webhook auto-subscribe failed:", msg);
  }
}

// ──────────────────────────────────────────
// GET /webhook  →  Meta verification handshake
// ──────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified by Meta");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ──────────────────────────────────────────
// POST /webhook  →  Incoming messages
// ──────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  // Debug log — shows everything Meta sends
  console.log("📨 Incoming webhook:", JSON.stringify(req.body));

  try {
    const entry   = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;

    // Ignore events from other phone numbers (e.g. 80339 chatbot)
    const incomingPhoneId = value?.metadata?.phone_number_id;
    if (incomingPhoneId && incomingPhoneId !== PHONE_NUMBER_ID) {
      console.log(`⏭️  Skipping event for other number: ${value?.metadata?.display_phone_number}`);
      return;
    }

    if (!value?.messages?.length) {
      console.log("ℹ️  No messages in payload (status update or other event)");
      return;
    }

    const msg     = value.messages[0];
    const contact = value.contacts?.[0];

    const phone     = msg.from;
    const name      = contact?.profile?.name || "";
    const timestamp = new Date(parseInt(msg.timestamp) * 1000).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
    });

    let response  = "";
    let queryText = "";

    if (msg.type === "button") {
      const btnText = msg.button?.text?.toUpperCase().trim();
      if (btnText === "YES")               response = "YES";
      else if (btnText === "NO")           response = "NO";
      else if (btnText === "HAVE A QUERY") response = "QUERY";
      else                                 response = btnText;
    }

    else if (msg.type === "interactive") {
      const reply = msg.interactive?.button_reply || msg.interactive?.list_reply;
      const id    = reply?.id?.toUpperCase();
      if (id === "YES")        response = "YES";
      else if (id === "NO")   response = "NO";
      else if (id === "QUERY") response = "QUERY";
      else                     response = reply?.title || id;
    }

    else if (msg.type === "text") {
      const text  = msg.text?.body?.trim() || "";
      const upper = text.toUpperCase();
      if (upper === "YES")     response = "YES";
      else if (upper === "NO") response = "NO";
      else {
        response  = "QUERY";
        queryText = text;
      }
    }

    else {
      response  = "OTHER";
      queryText = `[${msg.type}]`;
    }

    if (!response) return;

    console.log(`📥 ${name || phone} → ${response}${queryText ? ` | "${queryText}"` : ""}`);

    await appendToSheet({ phone, name, response, queryText, timestamp });

  } catch (err) {
    console.error("❌ Webhook processing error:", err.message);
  }
});

// ──────────────────────────────────────────
// Health check
// ──────────────────────────────────────────
app.get("/", (req, res) => res.send("WhatsApp tracker is running ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  await subscribeWebhook();
});