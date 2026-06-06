require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { appendToSheet } = require("./sheets");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const API_VERSION = "v21.0";
const BASE_URL = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;

// ──────────────────────────────────────────
// Image / PDF Configuration
// ──────────────────────────────────────────
// 👇👇👇 REPLACE THIS URL WITH YOUR ACTUAL IMAGE OR PDF LINK 👇👇👇
// Host the file somewhere publicly accessible and paste the URL below.
const MEDIA_URL = process.env.MEDIA_URL || "https://example.com/your-image.jpg";
const MEDIA_CAPTION = process.env.MEDIA_CAPTION || "Here are the program details.";

// ──────────────────────────────────────────
// In-memory state: tracks users who clicked
// "Have a query" and are about to type it
// ──────────────────────────────────────────
const awaitingQuery = new Map(); // phone → true

// ══════════════════════════════════════════
//  WhatsApp Cloud API — Sending helpers
// ══════════════════════════════════════════

/**
 * Send a plain text message to a WhatsApp user
 */
async function sendTextMessage(to, text) {
  try {
    await axios.post(
      BASE_URL,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log(`📤 Sent text to ${to}: "${text}"`);
  } catch (err) {
    console.error(
      `❌ Failed to send text to ${to}:`,
      err.response?.data || err.message
    );
  }
}

/**
 * Send an image to a WhatsApp user
 */
async function sendImage(to, imageUrl, caption) {
  try {
    await axios.post(
      BASE_URL,
      {
        messaging_product: "whatsapp",
        to,
        type: "image",
        image: { link: imageUrl, caption },
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log(`📤 Sent image to ${to}`);
  } catch (err) {
    console.error(
      `❌ Failed to send image to ${to}:`,
      err.response?.data || err.message
    );
  }
}

// ══════════════════════════════════════════
//  Webhook endpoints
// ══════════════════════════════════════════

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

    // ─────────────────────────────────────
    // 1. Check if user is awaiting query input
    //    (they clicked "Have a query" previously)
    // ─────────────────────────────────────
    if (awaitingQuery.has(phone) && msg.type === "text") {
      const text = msg.text?.body?.trim() || "";
      response = "QUERY";
      queryText = text;

      // Send acknowledgement
      await sendTextMessage(
        phone,
        "Thanks for your response, our executive will get in touch with you soon!"
      );

      // Clear the awaiting state
      awaitingQuery.delete(phone);

      console.log(
        `📥 ${name || phone} → QUERY (follow-up) | "${queryText}"`
      );

      await appendToSheet({ phone, name, response, queryText, timestamp });
      return;
    }

    // ─────────────────────────────────────
    // 2. Button messages (template quick replies)
    // ─────────────────────────────────────
    if (msg.type === "button") {
      const btnText = msg.button?.text?.toUpperCase().trim();

      if (btnText === "YES") response = "YES";
      else if (btnText === "NO") response = "NO";
      else if (
        btnText === "HAVE A QUERY" ||
        btnText === "HAVING A QUERY" ||
        btnText === "HAVING A QUERY!" ||
        btnText === "I HAVE A QUERY" ||
        btnText === "I HAVE A QUERY!"
      )
        response = "QUERY_PENDING";
      else response = btnText;
    }

    // ─────────────────────────────────────
    // 3. Interactive messages (button_reply / list_reply)
    // ─────────────────────────────────────
    else if (msg.type === "interactive") {
      const reply =
        msg.interactive?.button_reply ||
        msg.interactive?.list_reply;

      const id = reply?.id?.toUpperCase();

      if (id === "YES") response = "YES";
      else if (id === "NO") response = "NO";
      else if (id === "QUERY") response = "QUERY_PENDING";
      else response = reply?.title || id;
    }

    // ─────────────────────────────────────
    // 4. Free-text messages
    // ─────────────────────────────────────
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

    // ═════════════════════════════════════
    //  Send the appropriate reply
    // ═════════════════════════════════════
    if (response === "YES") {
      await sendTextMessage(
        phone,
        "Thanks for your response, we will get back to you with program details."
      );
      // Send image with program details
      await sendImage(phone, MEDIA_URL, MEDIA_CAPTION);
    }

    else if (response === "NO") {
      await sendTextMessage(phone, "Thanks for your response.");
    }

    else if (response === "QUERY_PENDING") {
      await sendTextMessage(phone, "Please mention your query below.");
      // Mark this user as awaiting their query text
      awaitingQuery.set(phone, true);
    }

    else if (response === "QUERY") {
      // Direct free-text query (user didn't click button first)
      await sendTextMessage(
        phone,
        "Thanks for your response, our executive will get in touch with you soon!"
      );
    }

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