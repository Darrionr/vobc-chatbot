# VOBC Chatbot Widget — Claude Code Build Spec

## Overview

Build a floating AI chatbot widget for vobiblecollege.org. It auto-pops up when a visitor lands on the site. It answers questions for both prospective students and current coordinators. It is powered by the Anthropic API.

The output is a single self-contained HTML file named `vobc-chatbot.html`. It will be hosted on Netlify and embedded into the WordPress site via an iframe snippet.

---

## Step 1 — Extract Branding from the Live Site

Before writing any CSS, use your browser tool to visit https://vobiblecollege.org and extract the following from the live site:

- Primary background color (used in the nav or hero section)
- Primary accent or highlight color (used on buttons or headings)
- Secondary/body text color
- Navigation bar background color
- Button background color and button text color
- Font families used (check the Google Fonts import or CSS font-family declarations)
- Any border or divider colors

Use those exact hex values throughout the widget. Do not guess or substitute. The widget must look like it belongs on the VOBC site.

Logo URL to use in the widget header:
`https://vobiblecollege.org/wp-content/uploads/2023/08/VOBC-Logo_200x200px-4.png`

---

## Step 2 — Widget Behavior

- A floating chat bubble sits in the bottom-right corner of the screen at all times.
- After 3.5 seconds on the page, a small tooltip appears above the bubble that reads: "Have a question about VOBC?"
- After 2.5 more seconds (6 seconds total), the chat window opens automatically.
- If the visitor already clicked the bubble before the auto-open fires, cancel the auto-open.
- Clicking the bubble toggles the window open and closed.
- The window shows a welcome message as soon as it opens (before the visitor types anything).
- After the visitor sends their first message, the quick-reply buttons disappear.

---

## Step 3 — Widget Structure

### Chat Window Sections (top to bottom)

1. Header
   - VOBC logo (circular, from logo URL above)
   - Title: "VOBC Assistant"
   - Subtitle: "Victory Outreach Bible College"
   - Small green online indicator dot

2. Message area
   - Scrollable list of bot and user messages
   - Bot messages have a small "V" avatar on the left
   - User messages align to the right
   - Typing indicator (three animated dots) while waiting for API response

3. Quick-reply buttons (shown only before first user message)
   - "How do I apply?"
   - "What programs do you offer?"
   - "How much does it cost?"
   - "When does the next quarter start?"
   - "Do you offer scholarships?"

4. Input area
   - Auto-resizing textarea (max 3 lines)
   - Send button (arrow icon)
   - Enter key sends the message (Shift+Enter adds a line break)

5. Footer
   - Small disclaimer: "Powered by VOBC • AI responses may not be fully accurate"

---

## Step 4 — Anthropic API Integration

Use the following configuration:

```
Endpoint: https://api.anthropic.com/v1/messages
Method: POST
Headers:
  Content-Type: application/json
  x-api-key: YOUR_ANTHROPIC_API_KEY_HERE
  anthropic-version: 2023-06-01
  anthropic-dangerous-direct-browser-access: true

Model: claude-sonnet-4-20250514
Max tokens: 300
```

Send the full conversation history with each request so the bot remembers the context of the conversation.

---

## Step 5 — System Prompt

Use this exact system prompt in every API call:

```
You are the official AI assistant for Victory Outreach Bible College (VOBC). You help prospective students, current students, and coordinators get answers about VOBC. Be warm, encouraging, and concise. Reflect the faith-based, mission-driven culture of VOBC. Keep responses under 150 words unless a detailed answer truly requires more. End answers to prospective students with a brief encouragement when appropriate.

PROGRAMS:
- Associate in Biblical and Theological Studies (V.E.T.I.) — 2-year program, 72 units total, 19 core courses + 5 elective courses
- Bachelor in Christian Ministry — 1-year completion program (42 units, 6 Modules) for Associate graduates
- Both programs available in English and Spanish
- Spanish Bachelor: 18-month Zoom program, Saturday mornings, $75/unit

TUITION (USA):
- 3-unit course: $215
- 1-unit course: $100
- Audit: $100
- Late fee: $20 after first day of class
- Payment by credit card only through student account. No payment plans. No refunds (transfer to another course allowed within first week only).

QUARTERS AND DATES (2026):
- Winter: January 19
- Spring: April 13
- Summer: July 13
- Fall: September 14
- Course requests are due 45 days before each quarter start.

ADMISSIONS:
- Associate (VETI): Apply via the MaestroSIS platform. No formal prerequisites.
- Bachelor: Must have a VETI Associate degree (or 2-year equivalent from another institution with official transcripts). Requires personal essay, two letters of recommendation (one personal, one ministry), and a $25 application fee. Send transcripts to: 250 W. Arrow Hwy, San Dimas, CA 91773.
- Application responses within 1-2 business days.

SCHOLARSHIPS:
- Six scholarship types: Coordinator, Leadership Hub, Victory Homes, DTC, UTC, TWLC
- Application due one week before each quarter start. No late submissions accepted.
- No general financial aid. VOBC is not regionally accredited.

ACCREDITATION:
- Recognized by BPPE (California)
- Credits can transfer to partnering universities for accredited Bachelor's or Master's degrees.
- VOBC is actively pursuing dual accreditation (WSCUC and ABHE).

CONTACT:
- Address: 250 W. Arrow Hwy., San Dimas, CA 91773
- Phone: (909) 599-4437
- Email: info@vobiblecollege.org
- Office Hours: Monday through Friday, 9am to 5pm

LEARNING FORMATS:
- In-person (local extensions), live Zoom, online (self-paced), on-demand (pre-recorded, available anytime)
- 71 active extensions worldwide

COORDINATOR REQUIREMENTS:
- Must be active church members and faithful tithers
- Instructors and ministers cannot serve simultaneously as coordinators
- Coordinators are tracked through an internal CRM system

LOGOS PARTNERSHIP:
- VOBC partners with Logos Bible Software for required textbooks
- Students who purchase required texts through Logos receive the Logos Academic Basic plan (valued at over $1,700)
- Textbooks are owned permanently and other Logos books are available at 50% discount

If you do not know the answer to a question, respond with: "I don't have that information on hand. Please contact us at info@vobiblecollege.org or call (909) 599-4437 and our team will be happy to help."
```

---

## Step 6 — Error Handling

If the API call fails for any reason, display this message in the chat:
"I'm having trouble connecting right now. Please contact us at info@vobiblecollege.org or call (909) 599-4437."

---

## Step 7 — Embedding the Widget on WordPress

After the HTML file is built and deployed to Netlify, add this snippet to the WordPress site footer using the "Insert Headers and Footers" plugin. Replace the URL with the actual Netlify deployment URL.

```html
<script>
  (function() {
    var iframe = document.createElement('iframe');
    iframe.src = 'https://YOUR-NETLIFY-URL.netlify.app';
    iframe.style.cssText = 'position:fixed;bottom:0;right:0;width:450px;height:650px;border:none;z-index:99999;background:transparent;pointer-events:all;';
    iframe.allow = 'clipboard-write';
    document.body.appendChild(iframe);
  })();
</script>
```

---

## Deliverable

One file: `vobc-chatbot.html`

- Fully self-contained (no external dependencies except the Anthropic API call)
- All CSS and JS inline in the single file
- API key placeholder clearly marked as `YOUR_ANTHROPIC_API_KEY_HERE`
- Branding matches vobiblecollege.org exactly based on colors extracted in Step 1
- Mobile responsive (max-width adjusts on screens under 480px)
