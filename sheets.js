const { google } = require("googleapis");

// ──────────────────────────────────────────
// Auth — uses a service account JSON stored
// as an env variable (safe for Render/cloud)
// ──────────────────────────────────────────
function getAuthClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON env var is not set");

  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch (e) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: " + e.message);
  }

  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

// ──────────────────────────────────────────
// Append a single response row to the sheet
// ──────────────────────────────────────────
async function appendToSheet({ phone, name, response, leadStatus, queryText, timestamp }) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!spreadsheetId) {
    console.warn("⚠️  GOOGLE_SHEET_ID not set — skipping sheet logging.");
    return;
  }

  let auth;
  try {
    auth = getAuthClient();
  } catch (e) {
    console.warn("⚠️  Google auth failed — skipping sheet logging:", e.message);
    return;
  }

  const sheets = google.sheets({ version: "v4", auth });

  // Column order: Timestamp | Phone | Name | Response | Lead Status | Query Text / Details
  const values = [[timestamp, phone, name, response, leadStatus, queryText]];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "Sheet1!A:F",
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });

  console.log(`✅ Logged to sheet: ${phone} → ${response} | ${leadStatus}`);
}

module.exports = { appendToSheet };
