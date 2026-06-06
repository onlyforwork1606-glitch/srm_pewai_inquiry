require("dotenv").config();
const express = require("express");
const { appendToSheet } = require("./sheets");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

// ──────────────────────────────────────────
// GET /webhook → Meta verification handshake
// ──────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified by Meta");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// ──────────────────────────────────────────
// POST /webhook → Incoming WhatsApp messages
// ──────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  console.log("📨 Incoming webhook:", JSON.stringify(req.body));

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value) return;

    const incomingPhoneId = value?.metadata?.phone_number_id;
    const incomingNumber = value?.metadata?.display_phone_number;

    console.log("📞 Configured Phone ID:", PHONE_NUMBER_ID);
    console.log("📞 Incoming Phone ID:", incomingPhoneId);
    console.log("📞 Incoming Number:", incomingNumber);

    // Ignore messages from other WhatsApp numbers
    if (incomingPhoneId && incomingPhoneId !== PHONE_NUMBER_ID) {
      console.log(
        `⏭️ Skipping event for other number: ${incomingNumber}`
      );
      return;
    }

    // Ignore status updates
    if (!value?.messages?.length) {
      console.log("ℹ️ No messages in payload (status update)");
      return;
    }

    const msg = value.messages[0];
    const contact = value.contacts?.[0];

    const phone = msg.from;
    const name = contact?.profile?.name || "";

    const timestamp = new Date(
      parseInt(msg.timestamp) * 1000
    ).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
    });

    let response = "";
    let queryText = "";

    // Button replies
    if (msg.type === "button") {
      const btnText = msg.button?.text?.toUpperCase().trim();

      if (btnText === "YES") response = "YES";
      else if (btnText === "NO") response = "NO";
      else if (btnText === "HAVE A QUERY") response = "QUERY";
      else response = btnText;
    }

    // Interactive replies
    else if (msg.type === "interactive") {
      const reply =
        msg.interactive?.button_reply ||
        msg.interactive?.list_reply;

      const id = reply?.id?.toUpperCase();

      if (id === "YES") response = "YES";
      else if (id === "NO") response = "NO";
      else if (id === "QUERY") response = "QUERY";
      else response = reply?.title || id;
    }

    // Text messages
    else if (msg.type === "text") {
      const text = msg.text?.body?.trim() || "";
      const upper = text.toUpperCase();

      if (upper === "YES") {
        response = "YES";
      } else if (upper === "NO") {
        response = "NO";
      } else {
        response = "QUERY";
        queryText = text;
      }
    }

    // Other message types
    else {
      response = "OTHER";
      queryText = `[${msg.type}]`;
    }

    if (!response) return;

    console.log(
      `📥 ${name || phone} → ${response}${
        queryText ? ` | "${queryText}"` : ""
      }`
    );

    await appendToSheet({
      phone,
      name,
      response,
      queryText,
      timestamp,
    });

    console.log(`✅ Logged to sheet: ${phone} → ${response}`);
  } catch (err) {
    console.error("❌ Webhook processing error:", err);
  }
});

// ──────────────────────────────────────────
// Health Check
// ──────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("WhatsApp tracker is running ✅");
});

// ──────────────────────────────────────────
// Start Server
// ──────────────────────────────────────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📞 Tracking Phone Number ID: ${PHONE_NUMBER_ID}`);
});