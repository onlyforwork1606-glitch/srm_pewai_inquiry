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
// Startup env-var validation
// ──────────────────────────────────────────
const REQUIRED_VARS = [
  "WEBHOOK_VERIFY_TOKEN",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "GOOGLE_SHEET_ID",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
];
const missing = REQUIRED_VARS.filter((v) => !process.env[v]);
if (missing.length) {
  console.warn("⚠️  Missing environment variables:", missing.join(", "));
  console.warn("   The server will start, but affected features will not work.");
}

// ──────────────────────────────────────────
// User state management (in-memory)
// ──────────────────────────────────────────
const userStates = new Map();

const ST_INITIAL = "INITIAL";
const ST_AWAITING_CALL_DECISION = "AWAITING_CALL_DECISION";
const ST_AWAITING_ADMISSION_DETAILS = "AWAITING_ADMISSION_DETAILS";

const MEET_LINK = "https://meet.google.com/mhq-uice-iuq";

// ──────────────────────────────────────────
// Post-meeting query time gate (10 July 2026, 11:00 AM IST)
// ──────────────────────────────────────────
const POST_MEETING_QUERY_UNLOCK = new Date("2026-07-10T11:00:00+05:30");

function isPostMeetingQueryUnlocked() {
  return new Date() >= POST_MEETING_QUERY_UNLOCK;
}

// ══════════════════════════════════════════
//  WhatsApp Cloud API — Sending helpers
// ══════════════════════════════════════════

async function sendTextMessage(to, text) {
  try {
    await axios.post(
      BASE_URL,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { preview_url: true, body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log(`📤 Sent text to ${to}`);
  } catch (err) {
    console.error(
      `❌ Failed to send text to ${to}:`,
      err.response?.data || err.message
    );
  }
}

async function sendInteractiveButtons(to, bodyText, buttons) {
  try {
    await axios.post(
      BASE_URL,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: bodyText },
          action: {
            buttons: buttons.map((b) => ({
              type: "reply",
              reply: { id: b.id, title: b.title },
            })),
          },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log(`📤 Sent interactive buttons to ${to}`);
  } catch (err) {
    console.error(
      `❌ Failed to send buttons to ${to}:`,
      err.response?.data || err.message
    );
  }
}

// ══════════════════════════════════════════
//  Webhook endpoints
// ══════════════════════════════════════════

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

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value) return;

    const incomingPhoneId = value?.metadata?.phone_number_id;

    if (incomingPhoneId && incomingPhoneId !== PHONE_NUMBER_ID) {
      return;
    }

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

    // Initialise or retrieve user state
    if (!userStates.has(phone)) {
      userStates.set(phone, { state: ST_INITIAL });
    }
    const userState = userStates.get(phone);

    // ─────────────────────────────────────
    //  Extract reply ID or free text
    // ─────────────────────────────────────
    let replyId = "";
    let queryText = "";

    if (msg.type === "button") {
      const rawText = msg.button?.text || "";
      const rawPayload = msg.button?.payload || "";
      const sanitized = rawText.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "").trim();
      const text = sanitized.toUpperCase();
      const payload = rawPayload.toUpperCase().trim();

      console.log(`🔍 Button | raw="${rawText}" | sanitized="${sanitized}" | payload="${rawPayload}"`);

      if (text.includes("TOMORROW")) {
        replyId = "ATTEND_TOMORROW";
      } else if (text.includes("POST") || text.includes("SESSION QUERY")) {
        replyId = "POST_MEETING_QUERY";
      } else if (text.includes("ATTEND") || text === "YES") {
        replyId = "ATTEND_YES";
      } else if (text.includes("DETAIL")) {
        replyId = "NEED_DETAILS";
      } else if (text.includes("GUIDANCE") || text.includes("ADMISSION")) {
        replyId = "NEED_GUIDANCE";
      } else {
        replyId = text;
      }
    } else if (msg.type === "interactive") {
      const reply = msg.interactive?.button_reply || msg.interactive?.list_reply;
      replyId = reply?.id || "";

      console.log(`🔍 Interactive | id="${replyId}" | title="${reply?.title || ""}"`);
    } else if (msg.type === "text") {
      queryText = msg.text?.body?.trim() || "";
    } else {
      console.log(`🔍 Unhandled msg type: ${msg.type}`);
      return;
    }

    console.log(
      `📥 ${name || phone} | state=${userState.state} | replyId="${replyId}" | text="${queryText}"`
    );

    // ─────────────────────────────────────
    //  Handle message based on state
    // ─────────────────────────────────────
    let response = "";
    let leadStatus = "";

    // Post-meeting query — time-gated, handled regardless of state
    if (replyId === "POST_MEETING_QUERY" || replyId === "btn_post_meeting_query") {
      if (isPostMeetingQueryUnlocked()) {
        await sendTextMessage(
          phone,
          "Thank you for your query. Our team will get back to you shortly."
        );
        response = "Post Session Query";
        leadStatus = "Post Session Query Received";
      } else {
        await sendTextMessage(
          phone,
          "This option will be available after the session on 10 July 2026 at 11:00 AM IST."
        );
        response = "Post Session Query (Early)";
        leadStatus = "Not Available Yet";
      }
      userStates.delete(phone);
    }

    else if (userState.state === ST_INITIAL) {
      const lowerText = queryText.toLowerCase();

      // Option 1b: Yes, I will attend tomorrow
      if (
        replyId === "ATTEND_TOMORROW" ||
        (replyId !== "ATTEND_YES" && lowerText.includes("tomorrow"))
      ) {
        await sendTextMessage(
          phone,
          "Thank you for confirming. Please join the session on 10 July at 03:00 PM using this link:\n" +
          MEET_LINK + "\n\n" +
          "We recommend joining with your parents."
        );
        response = "Yes, I will attend tomorrow";
        leadStatus = "Confirmed for Session";
        userStates.delete(phone);
      }
      // Option 1a: Yes, I will attend
      else if (
        replyId === "ATTEND_YES" ||
        lowerText.includes("attend") || lowerText === "yes"
      ) {
        await sendTextMessage(
          phone,
          "Thank you for confirming. Please join the session on 10 July at 03:00 PM using this link:\n" +
          MEET_LINK + "\n\n" +
          "We recommend joining with your parents."
        );
        response = "Yes, I will attend";
        leadStatus = "Confirmed for Session";
        userStates.delete(phone);
      }
      // Option 2: Need more details
      else if (
        replyId === "NEED_DETAILS" ||
        lowerText.includes("detail") || lowerText.includes("more info")
      ) {
        await sendTextMessage(
          phone,
          "B.Tech CSE in Product Engineering with AI is a specialised CSE pathway focused on AI-powered product building, real-world problem solving, industry exposure and career readiness.\n\n" +
          "Would you like an admission counsellor to call you?"
        );
        await sendInteractiveButtons(
          phone,
          "Choose an option:",
          [
            { id: "call_yes", title: "Yes, call me" },
            { id: "attend_session", title: "I will attend the session first" },
          ]
        );
        userState.state = ST_AWAITING_CALL_DECISION;
        response = "Need more details";
      }
      // Option 3: Need admission guidance
      else if (
        replyId === "NEED_GUIDANCE" ||
        lowerText.includes("guidance") || lowerText.includes("admission")
      ) {
        await sendTextMessage(
          phone,
          "Sure. Our admission counsellor will guide you.\n\n" +
          "Please share:\n" +
          "Student Name:\n" +
          "SRMJEE Application Number:\n" +
          "Parent Contact Number:\n" +
          "Preferred Call Time:"
        );
        userState.state = ST_AWAITING_ADMISSION_DETAILS;
        response = "Need Admission Guidance";
      } else {
        return;
      }
    } else if (userState.state === ST_AWAITING_CALL_DECISION) {
      const lowerText = queryText.toLowerCase();

      if (replyId === "call_yes" || lowerText.includes("call") || lowerText.includes("yes") || lowerText.includes("call me")) {
        await sendTextMessage(
          phone,
          "Thank you. Our counsellor will reach out to you shortly."
        );
        response = "Need more details → Yes, call me";
        leadStatus = "Counsellor Call Required";
        userStates.delete(phone);
      } else if (replyId === "attend_session" || lowerText.includes("attend") || lowerText.includes("session")) {
        await sendTextMessage(
          phone,
          "Great! Please join the session on 10 July at 03:00 PM using this link:\n" +
          MEET_LINK + "\n\n" +
          "We look forward to seeing you."
        );
        response = "Need more details → I will attend the session";
        leadStatus = "Warm Lead";
        userStates.delete(phone);
      } else {
        return;
      }
    } else if (userState.state === ST_AWAITING_ADMISSION_DETAILS) {
      await sendTextMessage(
        phone,
        "Noted, we will get back to you."
      );
      response = "Need Admission Guidance";
      leadStatus = "Hot Lead / Immediate Call";
      userStates.delete(phone);
    }

    // ─────────────────────────────────────
    //  Log to Google Sheets
    // ─────────────────────────────────────
    if (response) {
      console.log(`✅ ${name || phone} → ${response} | Lead: ${leadStatus}`);
      await appendToSheet({
        phone,
        name,
        response,
        leadStatus,
        queryText,
        timestamp,
      });
    }
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
