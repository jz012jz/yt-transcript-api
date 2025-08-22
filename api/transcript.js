import { parseStringPromise } from 'xml2js';

// Simple URL → videoId helper
function getVideoId(input) {
  try {
    const u = new URL(input);
    if (u.hostname.includes('youtu.be')) {
      const p = u.pathname.replace(/^\/+/, '');
      if (p) return p;
    }
    const v = u.searchParams.get('v');
    if (v) return v;
    const m = u.pathname.match(/\/shorts\/([A-Za-z0-9_-]{6,})/);
    if (m) return m[1];
  } catch (_) { /* fall back to regex */ }
  const rx = /(?:v=|youtu\.be\/|\/shorts\/)([A-Za-z0-9_-]{6,})/;
  const mm = String(input).match(rx);
  return mm ? mm[1] : null;
}

// tiny helpers
const norm = (s) => (s || '').toLowerCase();
const base = (s) => norm(s).split('-')[0];

const UA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'Accept-Language': 'en,en-US;q=0.9'
};

async function fetchText(url) {
  const r = await fetch(url, { headers: UA_HEADERS, redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.text();
}

function buildQuery(params) {
  return Object.entries(params)
    .filter(([_, v]) => v !== undefined && v !== null && String(v).length > 0)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
    .join('&');
}

async function listTracks(videoId) {
  const url = 'https://www.youtube.com/api/timedtext?' + buildQuery({ type: 'list', v: videoId });
  const xml = await fetchText(url).catch(() => '');
  if (!xml || !xml.includes('<transcript_list')) return [];
  const parsed = await parseStringPromise(xml).catch(() => null);
  const tracks = parsed?.transcript_list?.track || [];
  // xml2js gives attributes under "$"
  return tracks.map(t => ({
    lang_code: t.$?.lang_code || '',
    kind:      t.$?.kind || '',
    name:      t.$?.name || ''
  }));
}

async function timedtextJson3(params) {
  const u = 'https://www.youtube.com/api/timedtext?' + buildQuery({ ...params, fmt: 'json3' });
  try {
    const body = await fetchText(u);
    if (!body || body.trim().startsWith('<')) return '';
    const data = JSON.parse(body);
    if (!Array.isArray(data.events)) return '';
    const parts = [];
    for (const ev of data.events) {
      if (!ev?.segs) continue;
      for (const s of ev.segs) if (typeof s.utf8 === 'string') parts.push(s.utf8);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  } catch { return ''; }
}

async function timedtextXml(params) {
  const u = 'https://www.youtube.com/api/timedtext?' + buildQuery(params);
  try {
    const body = await fetchText(u);
    if (!body || !body.includes('<transcript')) return '';
    // quick & safe-ish text extraction without heavy HTML entities:
    const textNodes = Array.from(body.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)).map(m => m[1]);
    const decoded = textNodes
      .map(t => t
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10) || 0))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16) || 0))
      );
    return decoded.join(' ').replace(/\s+/g, ' ').trim();
  } catch { return ''; }
}

async function fetchUsingTrack(videoId, track, tlang) {
  const baseParams = { v: videoId, lang: track.lang_code };
  if (track.kind === 'asr') baseParams.kind = 'asr';
  if (track.name && track.kind !== 'asr') baseParams.name = track.name;
  if (tlang) baseParams.tlang = tlang;

  // JSON first, then XML
  let txt = await timedtextJson3(baseParams);
  if (txt) return txt;
  txt = await timedtextXml(baseParams);
  return txt || '';
}

async function smartFetch(videoId, preferredLang) {
  // 1) list available caption tracks
  const tracks = await listTracks(videoId);

  // 2) if none listed, try blind attempts
  if (!tracks.length) {
    const attempts = [
      await timedtextJson3({ v: videoId, fmt: 'json3', lang: preferredLang }),
      await timedtextJson3({ v: videoId, fmt: 'json3' }),
      await timedtextXml({ v: videoId, lang: preferredLang }),
      await timedtextXml({ v: videoId })
    ].filter(Boolean);
    return attempts[0] || '';
  }

  // 3) sort by preference: exact lang > same base > human > others
  const want = norm(preferredLang || '');
  const wantBase = base(want);
  const score = (t) =>
    (want && norm(t.lang_code) === want ? 4 : 0) +
    (wantBase && base(t.lang_code) === wantBase ? 2 : 0) +
    (t.kind !== 'asr' ? 1 : 0);

  tracks.sort((a, b) => score(b) - score(a));

  // 4) try tracks as-is
  for (const tr of tracks) {
    const txt = await fetchUsingTrack(videoId, tr, null);
    if (txt) return txt;
  }
  // 5) try translating tracks into preferred language (if provided)
  if (want) {
    for (const tr of tracks) {
      const txt = await fetchUsingTrack(videoId, tr, want);
      if (txt) return txt;
    }
  }
  return '';
}

export default async function handler(req, res) {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const { url, id, lang } = req.query || {};
    const videoId = id || (url ? getVideoId(url) : null);
    if (!videoId) return res.status(400).json({ error: 'Missing or invalid ?url= or ?id=' });

    // try: requested → 'en' → 'en-US' → 'en-GB' → none
    const tryLangs = [lang, 'en', 'en-US', 'en-GB', null].filter(Boolean);
    let text = '';
    for (const L of tryLangs) {
      text = await smartFetch(videoId, L);
      if (text) break;
    }

    if (!text) return res.status(404).json({ error: 'No transcript available' });
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
