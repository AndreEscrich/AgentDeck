// The title of a Google Sheets, Docs, Slides or Forms link, for the cards
// those links become in the chat (see gdocCard in renderer/render.js).
//
// Agent Hub has no Google sign-in, so this only works for files shared with
// anyone who has the link: the page's <title> then names the file. A private
// file sends you to Google's sign-in page instead, and the card keeps the
// link's own text. Nothing is sent but the link itself, without cookies.
// Answers are kept for the session, one request per file.

const { net } = require('electron');

const cache = new Map();   // file id -> Promise<string|null>

const SUFFIX = / - Google (Sheets|Docs|Slides|Forms|Drive)$/i;

function title(url) {
  const m = /^https:\/\/docs\.google\.com\/(spreadsheets|document|presentation|forms)\/d\/(?:e\/)?([\w-]{10,})/i.exec(String(url || ''));
  if (!m) return Promise.resolve(null);
  const key = `${m[1]}/${m[2]}`;
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 6000);
        const res = await net.fetch(`https://docs.google.com/${m[1]}/d/${m[2]}/edit`, { signal: controller.signal, credentials: 'omit', redirect: 'follow' });
        clearTimeout(timer);
        if (!res.ok || /accounts\.google\.com/.test(res.url)) return null;
        const html = (await res.text()).slice(0, 200000);
        const t = /<title>([^<]{1,300})<\/title>/i.exec(html)?.[1];
        if (!t || /sign in|google accounts|^google (sheets|docs|slides|forms)$/i.test(t.trim())) return null;
        return t.replace(SUFFIX, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim() || null;
      } catch {
        return null;
      }
    })());
  }
  return cache.get(key);
}

module.exports = { title };
