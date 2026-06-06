require("dotenv").config();
const express = require("express");
const { appendToSheet } = require("./sheets");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

// ──────────────────────────────────────────
// GET /webhook → Meta verification
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
// POST /webhook → Incoming messages
// ──────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value) return;

    const incomingPhoneId = value?.metadata?.phone_number_id;

    // Ignore other WhatsApp numbers completely
    if (incomingPhoneId && incomingPhoneId !== PHONE_NUMBER_ID) {
      return;
    }

    // Ignore status updates
    if (!value?.messages?.length) {
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

    // Button messages
    if (msg.type === "button") {
      const btnText = msg.button?.text?.toUpperCase().trim();

      if (btnText === "YES") response = "YES";
      else if (btnText === "NO") response = "NO";
      else if (btnText === "HAVE A QUERY") response = "QUERY";
      else response = btnText;
    }

    // Interactive messages
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