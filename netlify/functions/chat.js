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
const FETCH_TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

var _pageCache = { text: '', ts: 0 };

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/&#8211;|&ndash;/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchWithTimeout(url) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
  try {
    var res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'VOBC-Chatbot/1.0 (+https://vobiblecollege.org)' }
    });
    if (!res.ok) return '';
    var html = await res.text();
    return stripHtml(html);
  } catch (e) {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function getStudentPageText() {
  var now = Date.now();
  if (_pageCache.text && (now - _pageCache.ts) < CACHE_TTL_MS) return _pageCache.text;
  var text = await fetchWithTimeout(STUDENT_PAGE_URL);
  if (text) _pageCache = { text: text.slice(0, 3000), ts: now };
  return _pageCache.text;
}

async function getLiveWebsiteContext(question) {
  var results = await Promise.all([
    getStudentPageText(),
    fetchWithTimeout(SITE_SEARCH_URL + encodeURIComponent(question))
  ]);
  var studentPageText = results[0];
  var searchText = results[1].slice(0, 2500);

  var context = '';
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
          'do not say you don\'t have the information if it is covered here:\n\n' + liveContext;
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
