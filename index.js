require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const { appendToSheet } = require("./sheets");

const app = express();
app.use(express.json());

const VERIFY_TOKEN    = process.env.WEBHOOK_VERIFY_TOKEN;
const ACCESS_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const API_VERSION     = "v21.0";
const BASE_URL        = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;

// ──────────────────────────────────────────
// In-memory state: tracks users who clicked
// "I have a query!" and are about to type it
// ──────────────────────────────────────────
const awaitingQuery = new Map(); // phone → true

// ──────────────────────────────────────────
// PDF Configuration
// ──────────────────────────────────────────
// 👇👇👇  REPLACE THIS URL WITH YOUR ACTUAL PDF LINK  👇👇👇
// Host the PDF somewhere publicly accessible (Google Drive direct link,
// Cloudinary, S3, your own server, etc.) and paste the URL below.
const PDF_URL      = process.env.PDF_URL || "https://example.com/your-program-details.pdf";
const PDF_FILENAME = process.env.PDF_FILENAME || "Program_Details.pdf";
const PDF_CAPTION  = process.env.PDF_CAPTION  || "Here are the program details.";

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
    console.error(`❌ Failed to send text to ${to}:`, err.response?.data || err.message);
  }
}

/**
 * Send a PDF document to a WhatsApp user
 */
async function sendDocument(to, link, filename, caption) {
  try {
    await axios.post(
      BASE_URL,
      {
        messaging_product: "whatsapp",
        to,
        type: "document",
        document: { link, filename, caption },
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log(`📤 Sent PDF to ${to}: ${filename}`);
  } catch (err) {
    console.error(`❌ Failed to send PDF to ${to}:`, err.response?.data || err.message);
  }
}

// ══════════════════════════════════════════
//  Webhook endpoints
// ══════════════════════════════════════════

// ── GET /webhook → Meta verification handshake ──
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

// ── POST /webhook → Incoming messages / button taps ──
app.post("/webhook", async (req, res) => {
  // Always ack immediately so Meta doesn't retry
  res.sendStatus(200);

  try {
    const entry   = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;

    if (!value?.messages?.length) return; // status updates, read receipts, etc.

    const msg     = value.messages[0];
    const contact = value.contacts?.[0];

    const phone     = msg.from;                          // e.g. "919876543210"
    const name      = contact?.profile?.name || "";
    const timestamp = new Date(parseInt(msg.timestamp) * 1000).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
    });

    let response  = "";
    let queryText = "";

    // ─────────────────────────────────────
    // 1. Check if this user is in "awaiting query" state
    //    (they clicked "I have a query!" previously)
    // ─────────────────────────────────────
    if (awaitingQuery.has(phone) && msg.type === "text") {
      const text = msg.text?.body?.trim() || "";
      response  = "QUERY";
      queryText = text;

      // Send acknowledgement
      await sendTextMessage(phone, "Thanks for your response, our executive will get in touch with you soon!");

      // Clear the awaiting state
      awaitingQuery.delete(phone);

      console.log(`📥 ${name || phone} → QUERY (follow-up) | "${queryText}"`);
      await appendToSheet({ phone, name, response, queryText, timestamp });
      return;
    }

    // ─────────────────────────────────────
    // 2. Quick-reply button tap
    // ─────────────────────────────────────
    if (msg.type === "button") {
      const btnText = msg.button?.text?.toUpperCase().trim();
      if (btnText === "YES") {
        response = "YES";
      } else if (btnText === "NO") {
        response = "NO";
      } else if (
        btnText === "HAVE A QUERY" ||
        btnText === "HAVING A QUERY" ||
        btnText === "HAVING A QUERY!" ||
        btnText === "I HAVE A QUERY" ||
        btnText === "I HAVE A QUERY!"
      ) {
        response = "QUERY_PENDING";
      } else {
        response = btnText;
      }
    }

    // ─────────────────────────────────────
    // 3. Interactive list / button reply
    // ─────────────────────────────────────
    else if (msg.type === "interactive") {
      const reply = msg.interactive?.button_reply || msg.interactive?.list_reply;
      const id    = reply?.id?.toUpperCase();
      if (id === "YES")        response = "YES";
      else if (id === "NO")    response = "NO";
      else if (id === "QUERY") response = "QUERY_PENDING";
      else                     response = reply?.title || id;
    }

    // ─────────────────────────────────────
    // 4. Free-text reply (no awaiting state)
    // ─────────────────────────────────────
    else if (msg.type === "text") {
      const text  = msg.text?.body?.trim() || "";
      const upper = text.toUpperCase();
      if (upper === "YES")      response = "YES";
      else if (upper === "NO")  response = "NO";
      else {
        // Any other text treated as a direct query
        response  = "QUERY";
        queryText = text;
      }
    }

    // ─────────────────────────────────────
    // 5. Unsupported message types
    // ─────────────────────────────────────
    else {
      response  = "OTHER";
      queryText = `[${msg.type}]`;
    }

    if (!response) return;

    // ═════════════════════════════════════
    //  Send the appropriate reply
    // ═════════════════════════════════════
    if (response === "YES") {
      await sendTextMessage(phone, "Thanks for your response, we will get back to you with program details.");
      // Send PDF with program details
      await sendDocument(phone, PDF_URL, PDF_FILENAME, PDF_CAPTION);
    }

    else if (response === "NO") {
      await sendTextMessage(phone, "Thanks for your response.");
    }

    else if (response === "QUERY_PENDING") {
      await sendTextMessage(phone, "Please mention your query below.");
      // Mark this user as awaiting their query text
      awaitingQuery.set(phone, true);
      // Log the button tap (not the query yet)
      response = "QUERY_PENDING";
    }

    else if (response === "QUERY") {
      // Direct free-text query (user didn't click button first)
      await sendTextMessage(phone, "Thanks for your response, our executive will get in touch with you soon!");
    }

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
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
