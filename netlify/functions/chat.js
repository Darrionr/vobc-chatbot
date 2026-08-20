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
  // 18000 (the full page) blew Groq's 6000 tokens-per-minute limit on this model, breaking
  // every single message with a 413. 5000 is a deliberate compromise: comfortably covers the
  // known links (the minister's-license link sits around char 4100-4700) while leaving real
  // headroom in the total request size alongside the FAQ, search results, and static prompt.
  if (text) _pageCache = { text: text.slice(0, 5000), ts: now };
  return _pageCache.text;
}

function isSearchableContentUrl(url) {
  if (!/^https:\/\/vobiblecollege\.org\//i.test(url)) return false; // same site only
  if (/\/\?s=/i.test(url)) return false;                             // not the search page itself
  if (/\/(wp-login|wp-admin|feed|cdn-cgi)\b/i.test(url)) return false;
  if (/wp-content\/uploads/i.test(url)) return false;                // PDFs/images, not HTML pages
  if (/^https:\/\/vobiblecollege\.org\/(category|tag|author)\//i.test(url)) return false;
  return true;
}

// The site's theme renders every genuine search-result entry as a linked title
// immediately followed by a "by <Author> | <Date>" byline — sitewide nav links never
// have that byline right after them. That byline is a far more reliable signal for
// "this is a real result" than just collecting every link on the page (which mostly
// picks up the header/footer nav that's identical on every page, search or not).
function extractResultLinks(html) {
  var results = [];
  var re = /<a\s+[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]{1,150}?)<\/a>/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var url = resolveUrl(m[1]).split('#')[0];
    var afterPlain = html
      .slice(m.index + m[0].length, m.index + m[0].length + 200)
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ');
    if (/^\s*by\s+[\w .]+\s*\|/i.test(afterPlain)) {
      results.push(url);
    }
  }
  return results;
}

var MAX_SEARCH_PAGES = 2; // was 4 -- reduced along with the per-page cap below to fit Groq's token budget

// Runs the visitor's question through the site's own search, then fetches the FULL text of
// every distinct matching page (in parallel, not one-by-one) — not just the short excerpt
// the search-results listing shows. This is what lets the bot draw on the whole site for a
// given question, not just whatever's on the Student Page.
async function getSearchMatchedPages(question) {
  var searchHtml = await rawFetchWithTimeout(SITE_SEARCH_URL + encodeURIComponent(question));
  if (!searchHtml) return { snippet: '', pages: [] };

  var snippet = stripHtml(searchHtml).slice(0, 1500);

  var seen = {};
  var candidateUrls = [];
  extractResultLinks(searchHtml).forEach(function (url) {
    if (isSearchableContentUrl(url) && !seen[url]) {
      seen[url] = true;
      candidateUrls.push(url);
    }
  });

  var topUrls = candidateUrls.slice(0, MAX_SEARCH_PAGES);
  var fetched = await Promise.all(topUrls.map(async function (url) {
    var text = await fetchWithTimeout(url);
    return text ? { url: url, text: text.slice(0, 800) } : null;
  }));

  return { snippet: snippet, pages: fetched.filter(Boolean) };
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
  if (text) _faqCache = { text: text.slice(0, 2500), ts: now }; // was 8000 -- see token-budget note on getStudentPageText
  return _faqCache.text;
}

async function getLiveWebsiteContext(question) {
  var results = await Promise.all([
    getFaqText(),
    getStudentPageText(),
    getSearchMatchedPages(question)
  ]);
  var faqText         = results[0];
  var studentPageText  = results[1];
  var searchResult     = results[2];

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
  if (searchResult.pages.length > 0) {
    context += 'FULL CONTENT OF PAGES MATCHING THE VISITOR\'S QUESTION (found by searching all of ' +
      'vobiblecollege.org just now, not limited to the student page):\n\n';
    searchResult.pages.forEach(function (p) {
      context += '--- Page: ' + p.url + ' ---\n' + p.text + '\n\n';
    });
  } else if (searchResult.snippet) {
    context += 'LIVE SEARCH RESULTS FROM vobiblecollege.org FOR "' + question + '":\n' + searchResult.snippet + '\n\n';
  }
  return context;
}

var LINK_CHECK_TIMEOUT_MS = 3000;

function extractUrls(text) {
  var matches = text.match(/https?:\/\/[^\s\)\]}"'<>]+/g) || [];
  // Trim trailing punctuation a sentence might leave attached to the URL (e.g. "...org/page.")
  return matches.map(function (u) { return u.replace(/[.,;:!?]+$/, ''); });
}

async function urlReallyExists(url) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, LINK_CHECK_TIMEOUT_MS);
  try {
    var res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'VOBC-Chatbot/1.0 (+https://vobiblecollege.org)' }
    });
    return res.ok;
  } catch (e) {
    return false; // unreachable/timed out — treat as not existing rather than risk a bad link
  } finally {
    clearTimeout(timer);
  }
}

// Checks every URL the model actually put in its reply and removes any that don't
// really resolve, so a fabricated link can never reach a visitor even if the model
// ignored the anti-fabrication instructions in the prompt.
// "link text [URL]" is an internal notation used to preserve link destinations when
// live-fetched page content gets handed to the model — the model sometimes echoes it
// verbatim into its reply instead of paraphrasing it away, leaving visible "[...]"
// clutter (and it also confuses the front end's own link auto-detection). Strip the
// brackets down to a bare URL before anything else runs.
function unwrapBracketedUrls(text) {
  return text.replace(/\[(https?:\/\/[^\]\s]+)\]/g, '$1');
}

async function stripFabricatedLinks(replyText) {
  var text = unwrapBracketedUrls(replyText);
  var urls = extractUrls(text);
  if (urls.length === 0) return text;

  var unique = urls.filter(function (u, i) { return urls.indexOf(u) === i; });
  var checks = await Promise.all(unique.map(async function (u) {
    return { url: u, ok: await urlReallyExists(u) };
  }));

  var result = text;
  checks.forEach(function (c) {
    if (!c.ok) {
      var escaped = c.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(escaped, 'g'), '');
    }
  });
  return result.replace(/ {2,}/g, ' ').replace(/ ([.,!?])/g, '$1');
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

  var rawMessages = Array.isArray(payload.messages) ? payload.messages.slice() : [];
  var sysIndex = rawMessages.findIndex(function (m) { return m.role === 'system'; });
  var baseSystemContent = sysIndex !== -1 ? (rawMessages[sysIndex].content || '') : '';
  var history = rawMessages.filter(function (m, i) { return i !== sysIndex; });

  var lastUserMsg = '';
  for (var i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user') { lastUserMsg = history[i].content || ''; break; }
  }

  var liveNote = '';
  if (lastUserMsg) {
    try {
      var liveContext = await getLiveWebsiteContext(lastUserMsg);
      if (liveContext) {
        liveNote = '\n\nLIVE WEBSITE CONTEXT (fetched just now from vobiblecollege.org). ' +
          'If the answer to the visitor\'s question appears anywhere in this section, use it — ' +
          'do not say you don\'t have the information if it is covered here. Links appear here as ' +
          '"link text [URL]" — that square-bracket notation is only for you to read; when you cite ' +
          'a URL in your reply, write it as a plain bare URL with no brackets around it ' +
          '(https://example.com, never [https://example.com]).\n\n' +
          'ANTI-FABRICATION RULES — these override everything else, including any earlier ' +
          'instruction to always include a link:\n' +
          '1. NEVER invent, guess, construct, or modify a URL. Only ever use a URL that appears ' +
          'character-for-character in this context or in your core instructions above. If you do not ' +
          'have a real URL for something, either mention it with no link at all, or point to ' +
          'https://vobiblecollege.org/student-page ONLY if that is genuinely relevant — never produce ' +
          'a URL you are not certain is real.\n' +
          '2. NEVER state that a feature, service, form, or option exists (e.g. "you can check your ' +
          'scholarship status online," "you can track your application") unless it is explicitly ' +
          'described in your core instructions or in this live context. If you are unsure whether ' +
          'something exists, say you do not have that information instead of guessing or assuming it ' +
          'probably exists.\n' +
          '3. When you DO have a specific page or resource from your core instructions or this live ' +
          'context, include its real URL so the visitor can click straight to it — but a correct ' +
          'answer with no link is always better than a wrong answer with an invented one:\n\n' + liveContext;
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

  var PRIMARY_MODEL  = 'openai/gpt-oss-120b';
  var FALLBACK_MODEL = 'openai/gpt-oss-20b'; // used only if the primary model itself becomes unavailable
  var model = payload.model || PRIMARY_MODEL;
  var maxTokens = payload.max_tokens || 600;

  function buildMessages(includeLive, historyLimit) {
    var sysContent = baseSystemContent + (includeLive ? liveNote : '');
    var hist = historyLimit == null ? history : history.slice(Math.max(0, history.length - historyLimit));
    return [{ role: 'system', content: sysContent }].concat(hist);
  }

  // A model provider can retire a model with little or no notice (this happened for real:
  // the model this chatbot originally shipped with, llama-3.1-8b-instant, was silently
  // decommissioned by Groq). A request-size problem and a model-no-longer-exists problem
  // need different fixes, so detect which one happened and respond accordingly rather than
  // blindly retrying the same broken thing.
  function isModelUnavailableError(errData) {
    var msg  = (errData && errData.error && errData.error.message) || '';
    var code = (errData && errData.error && errData.error.code) || '';
    return code === 'model_not_found' || code === 'model_decommissioned' ||
      /decommission|does not exist|no longer supported/i.test(msg);
  }

  // Self-healing: rather than surface "having trouble connecting" to a visitor, automatically
  // retry with progressively less context for size/rate-limit errors, OR switch to the
  // fallback model if the primary one itself turns out to be unavailable — full live context
  // and the primary model are nice-to-have, but the core knowledge base and the visitor's
  // actual question are what must never get dropped.
  var attemptPlans = [
    { includeLive: true,  historyLimit: null },
    { includeLive: true,  historyLimit: 6 },
    { includeLive: false, historyLimit: 6 },
    { includeLive: false, historyLimit: 1 }
  ];

  var currentModel = model;
  var response, data;
  for (var p = 0; p < attemptPlans.length; p++) {
    var plan = attemptPlans[p];
    response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + API_KEY
      },
      body: JSON.stringify({
        model: currentModel,
        max_tokens: maxTokens,
        messages: buildMessages(plan.includeLive, plan.historyLimit)
      })
    });
    if (response.ok) { data = await response.json(); break; }
    data = await response.json().catch(function () { return null; });
    if (isModelUnavailableError(data) && currentModel !== FALLBACK_MODEL) {
      currentModel = FALLBACK_MODEL;
    }
  }

  // Instructions alone aren't reliable enough to stop this small/fast model from
  // occasionally inventing a plausible-looking but fake URL. As a real backstop (not just
  // a prompt rule), verify every URL in the actual reply and strip out any that don't
  // really exist before it ever reaches a visitor.
  try {
    var replyText = data && data.choices && data.choices[0] && data.choices[0].message &&
      data.choices[0].message.content;
    if (replyText) {
      data.choices[0].message.content = await stripFabricatedLinks(replyText);
    }
  } catch (e) {
    // If verification itself fails for any reason, fall back to the unmodified reply
    // rather than breaking the response.
  }

  return {
    statusCode: response.status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders),
    body: JSON.stringify(data)
  };
};
