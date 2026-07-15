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
const ST_MENU = "MENU";
const ST_AWAITING_CALL_DECISION = "AWAITING_CALL_DECISION";
const ST_AWAITING_ADMISSION_DETAILS = "AWAITING_ADMISSION_DETAILS";

const MEET_LINK = "https://meet.google.com/mhq-uice-iuq";

function lowerText(s) {
  return (s || "").toLowerCase();
}

// ──────────────────────────────────────────
// Post-meeting query time gate (10 July 2026, 11:00 AM IST)
// ──────────────────────────────────────────
const POST_MEETING_QUERY_UNLOCK = new Date("2026-07-10T11:00:00+05:30");

function isPostMeetingQueryUnlocked() {
  return new Date() >= POST_MEETING_QUERY_UNLOCK;
}

// ══════════════════════════════════════════
//  Menu & response constants
// ══════════════════════════════════════════

const MENU_OPTIONS = [
  { id: "menu_reserve_seat", title: "🎯 Reserve My Seat" },
  { id: "menu_about_program", title: "📚 About the Program" },
  { id: "menu_eligibility", title: "📋 Eligibility" },
  { id: "menu_joined_other", title: "❌ Joined Other College" },
];

const SUBMENU_PROGRAM_OPTIONS = [
  { id: "menu_program_details", title: "📘 Program Details" },
  { id: "menu_fee_details", title: "💰 Fee Details" },
  { id: "menu_placements", title: "🎓 Placements & Career" },
  { id: "menu_campus", title: "🏫 Campus & Hostel" },
  { id: "menu_back", title: "🔙 Back to Main Menu" },
];

const MENU_LIST_SECTIONS = [
  {
    title: "Choose an option",
    rows: MENU_OPTIONS.map((o) => ({ id: o.id, title: o.title })),
  },
];

const SUBMENU_LIST_SECTIONS = [
  {
    title: "About the Program",
    rows: SUBMENU_PROGRAM_OPTIONS.map((o) => ({ id: o.id, title: o.title })),
  },
];

const TEXT_PROGRAM_DETAILS =
  "B.Tech CSE - Product Engineering with AI (PEWAI) is a next-generation Computer Science program offered by SRM University AP.\n\n" +
  "The program combines:\n" +
  "• Industry-led training by CCC experts\n" +
  "• Artificial Intelligence & Product Engineering\n" +
  "• Full Stack Development\n" +
  "• Data Structures & Algorithms\n" +
  "• Real-world Industry Projects\n" +
  "• Internship Opportunities\n" +
  "• Industry Certifications\n" +
  "• Resume Building & AI Mock Interviews\n" +
  "• Placement-focused training from Day One";

const TEXT_FEE_DETAILS =
  "Annual Tuition Fee: ₹4,60,000/year";

const TEXT_PLACEMENTS =
  "PEWAI prepares students for careers as:\n" +
  "• AI Engineer\n" +
  "• Software Engineer\n" +
  "• Product Engineer\n" +
  "• Full Stack Developer\n" +
  "• Machine Learning Engineer\n" +
  "• Data Engineer\n\n" +
  "Students receive continuous placement preparation, mock interviews, coding practice and career mentoring throughout the program.";

const TEXT_CAMPUS =
  "SRM University AP offers:\n" +
  "• Modern Smart Campus\n" +
  "• Separate Boys & Girls Hostels\n" +
  "• Sports & Recreation Facilities\n" +
  "• Innovation Labs\n" +
  "• Student Clubs\n" +
  "• Research Opportunities\n" +
  "• Safe Residential Campus";

const TEXT_ELIGIBILITY =
  "Students who have completed Intermediate (MPC), CBSE or ICSE with the required minimum 60% percentage can apply.\n" +
  "Admissions are subject to SRM University AP norms.";

const TEXT_JOINED_OTHER =
  "Thank you for your response.\n" +
  "We wish you all the very best for your engineering journey and future career.";

async function sendMainMenu(to) {
  await sendTextMessage(to, "Please choose an option from the menu below:");
  const ok = await sendInteractiveList(to, "Select a topic", MENU_LIST_SECTIONS);
  if (!ok) {
    await sendTextMessage(to,
      "Please reply with a number:\n\n" +
      "1️⃣ 🎯 Reserve My Seat\n" +
      "2️⃣ 📚 About the Program\n" +
      "3️⃣ 📋 Eligibility\n" +
      "4️⃣ ❌ Joined Other College"
    );
  }
}

async function sendSubMenuProgram(to) {
  await sendTextMessage(to, "What would you like to know about the program?");
  const ok = await sendInteractiveList(to, "About the Program", SUBMENU_LIST_SECTIONS);
  if (!ok) {
    await sendTextMessage(to,
      "Please reply with a number:\n\n" +
      "1️⃣ 📘 Program Details\n" +
      "2️⃣ 💰 Fee Details\n" +
      "3️⃣ 🎓 Placements & Career\n" +
      "4️⃣ 🏫 Campus & Hostel\n" +
      "5️⃣ 🔙 Back to Main Menu"
    );
  }
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

async function sendInteractiveList(to, bodyText, sections) {
  try {
    await axios.post(
      BASE_URL,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: bodyText },
          action: {
            button: "View Options",
            sections: sections.map((s) => ({
              title: s.title,
              rows: s.rows.map((r) => ({
                id: r.id,
                title: r.title,
                ...(r.description ? { description: r.description } : {}),
              })),
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
    console.log(`📤 Sent interactive list to ${to}`);
    return true;
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error(
      `❌ Failed to send list to ${to}:`,
      JSON.stringify(detail, null, 2)
    );
    return false;
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

    // ── Map numeric text replies to menu IDs (fallback when interactive list fails) ──
    if (!replyId && /^[1-5]$/.test(queryText)) {
      const mainMap = { "1": "menu_reserve_seat", "2": "menu_about_program", "3": "menu_eligibility", "4": "menu_joined_other" };
      const subMap = { "1": "menu_program_details", "2": "menu_fee_details", "3": "menu_placements", "4": "menu_campus", "5": "menu_back" };
      replyId = userState.state === "SUBMENU_PROGRAM" ? (subMap[queryText] || "") : (mainMap[queryText] || "");
    }

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

    // ── Show main menu on first contact or explicit "menu" ──
    else if (userState.state === ST_INITIAL) {
      await sendMainMenu(phone);
      userState.state = ST_MENU;
      return;
    }

    // ── Menu state: route to the selected option ──
    if (userState.state === ST_MENU || replyId.startsWith("menu_")) {
      // Reserve seat — top-level, goes directly to admission team
      if (replyId === "menu_reserve_seat") {
        await sendTextMessage(
          phone,
          "Thank you for your interest in B.Tech CSE - Product Engineering with AI (PEWAI).\n\n" +
          "An Admission Counsellor will contact you shortly to guide you through the admission process and seat reservation."
        );
        response = "Reserve My Seat";
        leadStatus = "Seat Reservation Request";
        userStates.delete(phone);
      }

      // About the Program — opens sub-menu
      else if (replyId === "menu_about_program") {
        await sendSubMenuProgram(phone);
        userState.state = "SUBMENU_PROGRAM";
      }

      // Eligibility
      else if (replyId === "menu_eligibility") {
        await sendTextMessage(phone, TEXT_ELIGIBILITY);
        await sendMainMenu(phone);
        response = "Eligibility";
        leadStatus = "";
        userState.state = ST_MENU;
      }

      // I Have Already Joined Another College
      else if (replyId === "menu_joined_other") {
        await sendTextMessage(phone, TEXT_JOINED_OTHER);
        response = "Joined Another College";
        leadStatus = "Lost Lead";
        userStates.delete(phone);
      }

      // ── Sub-menu: About the Program ──
      else if (replyId === "menu_program_details") {
        await sendTextMessage(phone, TEXT_PROGRAM_DETAILS);
        await sendSubMenuProgram(phone);
        response = "Program Details";
        leadStatus = "";
      }

      else if (replyId === "menu_fee_details") {
        await sendTextMessage(phone, TEXT_FEE_DETAILS);
        await sendSubMenuProgram(phone);
        response = "Fee Details";
        leadStatus = "";
      }

      else if (replyId === "menu_placements") {
        await sendTextMessage(phone, TEXT_PLACEMENTS);
        await sendSubMenuProgram(phone);
        response = "Placements & Career";
        leadStatus = "";
      }

      else if (replyId === "menu_campus") {
        await sendTextMessage(phone, TEXT_CAMPUS);
        await sendSubMenuProgram(phone);
        response = "Campus & Hostel";
        leadStatus = "";
      }

      // Back to main menu
      else if (replyId === "menu_back") {
        await sendMainMenu(phone);
        userState.state = ST_MENU;
        return;
      }

      // Legacy options kept for backward compatibility
      else if (
        replyId === "ATTEND_TOMORROW" ||
        lowerText(queryText).includes("tomorrow")
      ) {
        await sendTextMessage(
          phone,
          "Thank you for confirming. Please join the session tomorrow 1 July at 10:00 AM using this link:\n" +
          MEET_LINK + "\n\n" +
          "We recommend joining with your parents."
        );
        response = "Yes, I will attend tomorrow";
        leadStatus = "Confirmed for Session";
        userStates.delete(phone);
      } else if (
        replyId === "ATTEND_YES" ||
        lowerText(queryText).includes("attend") ||
        lowerText(queryText) === "yes"
      ) {
        await sendTextMessage(
          phone,
          "Thank you for confirming. Please join the session on 10 July at 10:00 AM using this link:\n" +
          MEET_LINK + "\n\n" +
          "We recommend joining with your parents."
        );
        response = "Yes, I will attend";
        leadStatus = "Confirmed for Session";
        userStates.delete(phone);
      } else if (
        replyId === "NEED_DETAILS" ||
        lowerText(queryText).includes("detail") ||
        lowerText(queryText).includes("more info")
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
      } else if (
        replyId === "NEED_GUIDANCE" ||
        lowerText(queryText).includes("guidance") ||
        lowerText(queryText).includes("admission")
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
        // Unknown selection — re-show current menu
        await sendTextMessage(phone, "Sorry, I didn't understand that. Please choose from the menu below.");
        if (userState.state === "SUBMENU_PROGRAM") {
          await sendSubMenuProgram(phone);
        } else {
          await sendMainMenu(phone);
        }
        return;
      }
    } else if (userState.state === "SUBMENU_PROGRAM") {
      // Also handle sub-menu selections when state is explicitly set
      if (replyId === "menu_program_details") {
        await sendTextMessage(phone, TEXT_PROGRAM_DETAILS);
        await sendSubMenuProgram(phone);
        response = "Program Details";
      } else if (replyId === "menu_fee_details") {
        await sendTextMessage(phone, TEXT_FEE_DETAILS);
        await sendSubMenuProgram(phone);
        response = "Fee Details";
      } else if (replyId === "menu_placements") {
        await sendTextMessage(phone, TEXT_PLACEMENTS);
        await sendSubMenuProgram(phone);
        response = "Placements & Career";
      } else if (replyId === "menu_campus") {
        await sendTextMessage(phone, TEXT_CAMPUS);
        await sendSubMenuProgram(phone);
        response = "Campus & Hostel";
      } else if (replyId === "menu_back") {
        await sendMainMenu(phone);
        userState.state = ST_MENU;
        return;
      } else {
        await sendTextMessage(phone, "Sorry, I didn't understand that. Please choose from the menu below.");
        await sendSubMenuProgram(phone);
        return;
      }
    } else if (userState.state === ST_AWAITING_CALL_DECISION) {
      const lower = lowerText(queryText);

      if (replyId === "call_yes" || lower.includes("call") || lower.includes("yes") || lower.includes("call me")) {
        await sendTextMessage(
          phone,
          "Thank you. Our counsellor will reach out to you shortly."
        );
        response = "Need more details → Yes, call me";
        leadStatus = "Counsellor Call Required";
        userStates.delete(phone);
      } else if (replyId === "attend_session" || lower.includes("attend") || lower.includes("session")) {
        await sendTextMessage(
          phone,
          "Great! Please join the session on 10 July at 10:00 AM using this link:\n" +
          MEET_LINK + "\n\n" +
          "We look forward to seeing you."
        );
        response = "Need more details → I will attend the session";
        leadStatus = "Warm Lead";
        userStates.delete(phone);
      } else {
        console.warn(`⚠️ Unmatched replyId in ST_AWAITING_CALL: "${replyId}"`);
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
