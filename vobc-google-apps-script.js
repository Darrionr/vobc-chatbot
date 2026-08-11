// VOBC Chatbot Backend — Google Apps Script
// ─────────────────────────────────────────────────────────────────────────────
// HOW TO DEPLOY:
//  1. Go to script.google.com and create a new project
//  2. Paste this entire file into the editor
//  3. Click Deploy > New Deployment > Web App
//  4. Set "Execute as" = Me, "Who has access" = Anyone
//  5. Click Deploy and copy the Web App URL
//  6. Paste that URL into vobc-chatbot.html as the WEBHOOK_URL value
//
// This script creates two sheets in the active spreadsheet:
//  • Leads        — name, email, phone, page, last question, language, timestamp
//  • Conversations — question, answer, page, language, timestamp
// ─────────────────────────────────────────────────────────────────────────────

function doPost(e) {
  try {
    var ss   = SpreadsheetApp.getActiveSpreadsheet();
    var data = JSON.parse(e.postData.contents);

    if (data.type === 'lead') {
      var leadsSheet = ss.getSheetByName('Leads');
      if (!leadsSheet) {
        leadsSheet = ss.insertSheet('Leads');
        leadsSheet.appendRow(['Timestamp', 'Name', 'Email', 'Phone', 'Language', 'Page', 'Last Question']);
        leadsSheet.getRange(1, 1, 1, 7).setFontWeight('bold').setBackground('#0A1E40').setFontColor('#ffffff');
        leadsSheet.setColumnWidth(1, 160);
        leadsSheet.setColumnWidth(2, 150);
        leadsSheet.setColumnWidth(3, 200);
        leadsSheet.setColumnWidth(4, 130);
        leadsSheet.setColumnWidth(5, 80);
        leadsSheet.setColumnWidth(6, 300);
        leadsSheet.setColumnWidth(7, 300);
      }
      leadsSheet.appendRow([
        new Date(),
        data.name        || '',
        data.email       || '',
        data.phone       || '',
        data.lang        || 'en',
        data.page        || '',
        data.lastQuestion || ''
      ]);

      // Send email notification for new leads
      var adminEmail = Session.getActiveUser().getEmail();
      if (adminEmail) {
        MailApp.sendEmail({
          to:      adminEmail,
          subject: 'New VOBC Chatbot Lead: ' + (data.name || 'Unknown'),
          body:    'A new lead was submitted through the VOBC chatbot.\n\n' +
                   'Name:          ' + (data.name  || '') + '\n' +
                   'Email:         ' + (data.email || '') + '\n' +
                   'Phone:         ' + (data.phone || '') + '\n' +
                   'Language:      ' + (data.lang  || 'en') + '\n' +
                   'Page:          ' + (data.page  || '') + '\n' +
                   'Last Question: ' + (data.lastQuestion || '') + '\n'
        });
      }
    }

    if (data.type === 'conversation') {
      var convSheet = ss.getSheetByName('Conversations');
      if (!convSheet) {
        convSheet = ss.insertSheet('Conversations');
        convSheet.appendRow(['Timestamp', 'Language', 'Question', 'Answer', 'Page']);
        convSheet.getRange(1, 1, 1, 5).setFontWeight('bold').setBackground('#304975').setFontColor('#ffffff');
        convSheet.setColumnWidth(1, 160);
        convSheet.setColumnWidth(2, 80);
        convSheet.setColumnWidth(3, 280);
        convSheet.setColumnWidth(4, 280);
        convSheet.setColumnWidth(5, 300);
      }
      convSheet.appendRow([
        new Date(),
        data.lang     || 'en',
        data.question || '',
        data.answer   || '',
        data.page     || ''
      ]);
    }

    return ContentService
      .createTextOutput(JSON.stringify({ status: 'ok' }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'error', message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Simple GET handler — confirms the script is live
function doGet(e) {
  return ContentService
    .createTextOutput('VOBC Chatbot Analytics is active.')
    .setMimeType(ContentService.MimeType.TEXT);
}
