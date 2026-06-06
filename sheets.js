const { google } = require("googleapis");

// ──────────────────────────────────────────
// Auth — uses a service account JSON stored
// as an env variable (safe for Render/cloud)
// ──────────────────────────────────────────
function getAuthClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

// ──────────────────────────────────────────
// Append a single response row to the sheet
// ──────────────────────────────────────────
async function appendToSheet({ phone, name, response, queryText, timestamp }) {
  const auth       = getAuthClient();
  const sheets     = google.sheets({ version: "v4", auth });
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  // Column order: Timestamp | Phone | Name | Response | Query Text
  const values = [[timestamp, phone, name, response, queryText]];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "Sheet1!A:E",          // change "Sheet1" if your tab is named differently
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });

  console.log(`✅ Logged to sheet: ${phone} → ${response}`);
}

module.exports = { appendToSheet };
