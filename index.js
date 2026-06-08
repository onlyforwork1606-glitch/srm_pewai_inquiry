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
// Video Configuration
// ──────────────────────────────────────────
// 👇👇👇 PASTE YOUR GOOGLE DRIVE VIDEO DIRECT LINK HERE 👇👇👇
// To get a direct link from Google Drive:
//   1. Right-click the video → Share → "Anyone with the link"
//   2. Copy the file ID from the share URL
//   3. Use this format: https://drive.google.com/uc?export=download&id=YOUR_FILE_ID
const VIDEO_URL = process.env.VIDEO_URL || "https://res.cloudinary.com/du7fyr47e/video/upload/v1780809477/SRM_UNIVERSITY_-_AP_COURSE_1_1_aoy6la.mp4";
const VIDEO_CAPTION = process.env.VIDEO_CAPTION || "B.Tech CSE – Product Engineering with AI (PEWAI) | SRM University AP";

// ──────────────────────────────────────────
// WhatsApp contact link for "Contact" button
// ──────────────────────────────────────────
const CONTACT_WHATSAPP_URL =
  "https://api.whatsapp.com/send/?phone=919949698240&text=I+want+to+know+more+about+the+SRM+AP+Btech+PEWAI+programme&type=phone_number&app_absent=0";

// ══════════════════════════════════════════
//  WhatsApp Cloud API — Sending helpers
// ══════════════════════════════════════════

/**
 * Send a plain text message
 */
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

/**
 * Send a video message
 */
async function sendVideo(to, videoUrl, caption) {
  try {
    await axios.post(
      BASE_URL,
      {
        messaging_product: "whatsapp",
        to,
        type: "video",
        video: { link: videoUrl, caption },
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log(`📤 Sent video to ${to}`);
  } catch (err) {
    console.error(
      `❌ Failed to send video to ${to}:`,
      err.response?.data || err.message
    );
  }
}

/**
 * Send an interactive CTA URL button message
 * (Renders a tappable button that opens a URL)
 */
async function sendCtaUrlButton(to, bodyText, buttonText, url) {
  try {
    await axios.post(
      BASE_URL,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "cta_url",
          body: { text: bodyText },
          action: {
            name: "cta_url",
            parameters: {
              display_text: buttonText,
              url: url,
            },
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
    console.log(`📤 Sent CTA button to ${to}: "${buttonText}"`);
  } catch (err) {
    console.error(
      `❌ Failed to send CTA button to ${to}:`,
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
    // 1. Button messages (template quick replies)
    // ─────────────────────────────────────
    if (msg.type === "button") {
      const btnText = msg.button?.text?.toUpperCase().trim();

      if (btnText === "YES") response = "YES";
      else if (btnText === "NO") response = "NO";
      else if (
        btnText === "CONTACT" ||
        btnText === "HAVE A QUERY" ||
        btnText === "HAVING A QUERY" ||
        btnText === "HAVING A QUERY!" ||
        btnText === "I HAVE A QUERY" ||
        btnText === "I HAVE A QUERY!"
      )
        response = "QUERY";
      else response = btnText;
    }

    // ─────────────────────────────────────
    // 2. Interactive messages (button_reply / list_reply)
    // ─────────────────────────────────────
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

    // ─────────────────────────────────────
    // 3. Free-text messages
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
      // Send greeting with the program link and video link
      await sendTextMessage(
        phone,
        "Thanks for your interest! 🎓\n\n" +
        "Here are the details about B.Tech CSE – Product Engineering with AI (PEWAI) at SRM University AP:\n\n" +
        "🔗 Program Info: https://www.srmap.edu.in/seas/computer-science-and-engineering/b-tech-cse-product-engineering-with-ai/\n\n" +
        "🎥 Watch Program Video: " + VIDEO_URL + "\n\n" +
        "We will get back to you with more program details soon."
      );
    }

    else if (response === "NO") {
      await sendTextMessage(
        phone,
        "Thanks for your response.\n\n" +
        "You can go through the course details here:\n\n" +
        "🔗 Program Info: https://www.srmap.edu.in/seas/computer-science-and-engineering/b-tech-cse-product-engineering-with-ai/\n\n" +
        "🎥 Watch Program Video: " + VIDEO_URL
      );
    }

    else if (response === "QUERY") {
      // Send message with a CTA button to contact the team
      await sendCtaUrlButton(
        phone,
        "Thank you for your interest in the programme! 🙌\n\nYou can directly connect with our team for any queries.",
        "Contact Team 💬",
        CONTACT_WHATSAPP_URL
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