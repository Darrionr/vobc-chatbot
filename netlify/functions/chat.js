// Server-side proxy for the VOBC chatbot.
// - Keeps the Groq API key out of the browser (it used to be hardcoded in vobc-chatbot.html,
//   visible to anyone via "view source" — set GROQ_API_KEY in Netlify env vars instead, and
//   rotate the old key since it was public).
// - Before every reply, live-fetches vobiblecollege.org (the student page + a site search for
//   the visitor's question) and hands that text to the model as extra context, so the bot can
//   answer things that are on the site but not baked into the static knowledge base.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const STUDENT_PAGE_URL = 'https://vobiblecollege.org/student-page/';
const SITE_SEARCH_URL = 'https://vobiblecollege.org/?s=';
const FAQ_SHEET_ID = '1Nl3VQflf2uSgBOX6csGbhw8_BTzYh48V5PxnDCNMvhQ';
const FAQ_CSV_URL = 'https://docs.google.com/spreadsheets/d/' + FAQ_SHEET_ID + '/export?format=csv';
const FETCH_TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

var _pageCache = { text: '', ts: 0 };
var _faqCache  = { text: '', ts: 0 };

function resolveUrl(href) {
  if (/^https?:\/\//i.test(href)) return href;
  if (href.indexOf('//') === 0) return 'https:' + href;
  if (href.indexOf('/') === 0) return 'https://vobiblecollege.org' + href;
  return 'https://vobiblecollege.org/' + href;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Preserve link destinations as "link text [URL]" before stripping tags, so the
    // model can cite the exact page/section a live-fetched answer came from, not just
    // its text — otherwise every href gets thrown away by the generic tag-strip below.
    .replace(/<a\s+[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, function (m, href, inner) {
      var linkText = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (!linkText) return '';
      return linkText + ' [' + resolveUrl(href) + ']';
    })
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/&#8211;|&ndash;/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

async function rawFetchWithTimeout(url) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
  try {
    var res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'VOBC-Chatbot/1.0 (+https://vobiblecollege.org)' }
    });
    if (!res.ok) return '';
    return await res.text();
  } catch (e) {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithTimeout(url) {
  var raw = await rawFetchWithTimeout(url);
  return raw ? stripHtml(raw) : '';
}

async function getStudentPageText() {
  var now = Date.now();
  if (_pageCache.text && (now - _pageCache.ts) < CACHE_TTL_MS) return _pageCache.text;
  var text = await fetchWithTimeout(STUDENT_PAGE_URL);
  if (text) _pageCache = { text: text.slice(0, 3000), ts: now };
  return _pageCache.text;
}

// Minimal RFC 4180 CSV parser — handles quoted fields containing commas,
// newlines, and escaped ("") quotes, which the FAQ sheet's answer column has.
function parseCsv(text) {
  var rows = [];
  var row = [];
  var field = '';
  var inQuotes = false;
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\r') {
      // skip
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// Matches "<Month> <day>" (e.g. "January 19th", "December 20th") — used to drop any FAQ
// row containing a specific calendar date, since the sheet's dates are unreliable/stale
// but its policy/procedure answers are still good. Dates should only ever come from the
// verified QUARTER START DATES section of the core system prompt, never this sheet.
// No trailing \b: "19th" has no word boundary between the digit and "th", so requiring
// one there would silently fail to match ordinal-suffixed dates.
var DATE_PATTERN = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}/i;

async function getFaqText() {
  var now = Date.now();
  if (_faqCache.text && (now - _faqCache.ts) < CACHE_TTL_MS) return _faqCache.text;
  var csv = await rawFetchWithTimeout(FAQ_CSV_URL);
  if (!csv) return _faqCache.text; // keep last known-good copy rather than dropping it on a transient failure
  var rows = parseCsv(csv);
  // Find the real header row by content ("Question" in column 1) instead of assuming a fixed
  // row index — the sheet has a title row above its header, and that offset could change.
  var headerIdx = rows.findIndex(function (r) { return (r[1] || '').trim().toLowerCase() === 'question'; });
  var startAt = headerIdx === -1 ? 0 : headerIdx + 1;
  var pairs = [];
  for (var r = startAt; r < rows.length; r++) {
    var question = (rows[r][1] || '').replace(/\s+/g, ' ').trim();
    var answer   = (rows[r][2] || '').replace(/\s+/g, ' ').trim();
    if (!question || !answer) continue;
    if (DATE_PATTERN.test(question) || DATE_PATTERN.test(answer)) continue;
    pairs.push('Q: ' + question + '\nA: ' + answer);
  }
  var text = pairs.join('\n\n');
  if (text) _faqCache = { text: text.slice(0, 8000), ts: now };
  return _faqCache.text;
}

async function getLiveWebsiteContext(question) {
  var results = await Promise.all([
    getFaqText(),
    getStudentPageText(),
    fetchWithTimeout(SITE_SEARCH_URL + encodeURIComponent(question))
  ]);
  var faqText        = results[0];
  var studentPageText = results[1];
  var searchText      = results[2].slice(0, 2500);

  var context = '';
  if (faqText) {
    context += 'OFFICIAL VOBC FAQ (staff-maintained). Use it for policy and procedure answers ' +
      '(refunds, enrollment steps, transcripts, etc.). Two rules: ' +
      '(1) Ignore any specific calendar dates in this FAQ — quarter start dates, enrollment-open ' +
      'dates, and deadlines here may be outdated. For any date, always use the dates given in your ' +
      'core system instructions instead, never a date from this FAQ. ' +
      '(2) This FAQ is a supplement, not the only source — if a topic is not mentioned here, that ' +
      'does NOT mean it is unanswerable. Check your core system instructions and the other live ' +
      'content below before ever saying you do not have the information.\n\n' + faqText + '\n\n';
  }
  if (studentPageText) {
    context += 'LIVE CONTENT FROM vobiblecollege.org/student-page:\n' + studentPageText + '\n\n';
  }
  if (searchText) {
    context += 'LIVE SEARCH RESULTS FROM vobiblecollege.org FOR "' + question + '":\n' + searchText + '\n\n';
  }
  return context;
}

exports.handler = async (event) => {
  var corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };
  }

  var payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  var messages = Array.isArray(payload.messages) ? payload.messages.slice() : [];
  var lastUserMsg = '';
  for (var i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { lastUserMsg = messages[i].content || ''; break; }
  }

  if (lastUserMsg) {
    try {
      var liveContext = await getLiveWebsiteContext(lastUserMsg);
      if (liveContext) {
        var sysIndex = messages.findIndex(function (m) { return m.role === 'system'; });
        var note = '\n\nLIVE WEBSITE CONTEXT (fetched just now from vobiblecollege.org). ' +
          'If the answer to the visitor\'s question appears anywhere in this section, use it — ' +
          'do not say you don\'t have the information if it is covered here. Links appear as ' +
          '"link text [URL]" — when your answer points the visitor to a specific page or resource ' +
          'found here, include its exact [URL] in your reply so they can click straight to it, ' +
          'instead of just saying "vobiblecollege.org" or describing where to look:\n\n' + liveContext;
        if (sysIndex !== -1) {
          messages[sysIndex] = { role: 'system', content: messages[sysIndex].content + note };
        } else {
          messages.unshift({ role: 'system', content: note.trim() });
        }
      }
    } catch (e) {
      // Live lookup is best-effort; fall back to the static knowledge base silently.
    }
  }

  var API_KEY = process.env.GROQ_API_KEY;
  if (!API_KEY) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'GROQ_API_KEY is not configured on the server.' })
    };
  }

  var response = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + API_KEY
    },
    body: JSON.stringify({
      model: payload.model || 'llama-3.1-8b-instant',
      max_tokens: payload.max_tokens || 600,
      messages: messages
    })
  });
  var data = await response.json();

  return {
    statusCode: response.status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
    body: JSON.stringify(data)
  };
};
