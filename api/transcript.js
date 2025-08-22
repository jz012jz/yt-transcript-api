// --- minimal, zero-dependency YouTube transcript fetcher with debug ---

// URL → videoId
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
  } catch (_) {}
  const rx = /(?:v=|youtu\.be\/|\/shorts\/)([A-Za-z0-9_-]{6,})/;
  const mm = String(input).match(rx);
  return mm ? mm[1] : null;
}

const UA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'Accept-Language': 'en,en-US;q=0.9'
};

const norm = (s) => (s || '').toLowerCase();
const base = (s) => norm(s).split('-')[0];

function q(params) {
  return Object.entries(params)
    .filter(([_, v]) => v !== undefined && v !== null && String(v).length > 0)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
    .join('&');
}

async function fetchText(url) {
  const r = await fetch(url, { headers: UA_HEADERS, redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.text();
}

// ---------- Track listing (regex-based) ----------
function parseTrackListXML(xml) {
  // returns [{lang_code, kind, name}]
  const tracks = [];
  if (!xml || !xml.includes('<transcript_list')) return tracks;

  // match <track ... />
  const tagRe = /<track\b([^>]*)\/>/g;
  let m;
  while ((m = tagRe.exec(xml)) !== null) {
    const attrs = m[1] || '';
    const attrMap = {};
    // key="value"
    const attrRe = /(\w+)="([^"]*)"/g;
    let a;
    while ((a = attrRe.exec(attrs)) !== null) {
      attrMap[a[1]] = a[2];
    }
    tracks.push({
      lang_code: attrMap.lang_code || '',
      kind: attrMap.kind || '',
      name: attrMap.name || ''
    });
  }
  return tracks;
}

async function listTracks(videoId) {
  const url = 'https://www.youtube.com/api/timedtext?' + q({ type: 'list', v: videoId });
  const xml = await fetchText(url).catch(() => '');
  return parseTrackListXML(xml);
}

// ---------- Timedtext fetchers ----------
async function timedtextJson3(params) {
  const u = 'https://www.youtube.com/api/timedtext?' + q({ ...params, fmt: 'json3' });
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
  const u = 'https://www.youtube.com/api/timedtext?' + q(params);
  try {
    const body = await fetchText(u);
    if (!body || !body.includes('<transcript')) return '';
    const texts = Array.from(body.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)).map(m => m[1]);
    const decoded = texts.map(t => t
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

async function timedtextVtt(params) {
  const u = 'https://www.youtube.com/api/timedtext?' + q({ ...params, fmt: 'vtt' });
  try {
    const body = await fetchText(u);
    if (!body || !body.includes('WEBVTT')) return '';
    return body
      .replace(/^WEBVTT.*$/m, '')
      .replace(/\d{2}:\d{2}:\d{2}\.\d{3} --> .*$/gm, '')
      .replace(/^\s*\d+\s*$/gm, '')
      .replace(/<\/?c[.\w-]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  } catch { return ''; }
}

async function fetchUsingTrack(videoId, track, tlang) {
  const baseParams = { v: videoId, lang: track.lang_code };
  if (track.kind === 'asr') baseParams.kind = 'asr';
  if (track.name && track.kind !== 'asr') baseParams.name = track.name;
  if (tlang) baseParams.tlang = tlang;

  let txt = await timedtextJson3(baseParams);
  if (txt) return txt;
  txt = await timedtextXml(baseParams);
  if (txt) return txt;
  txt = await timedtextVtt(baseParams);
  return txt || '';
}

async function smartFetch(videoId, preferredLang) {
  const tracks = await listTracks(videoId);

  if (!tracks.length) {
    const attempts = [
      await timedtextJson3({ v: videoId, lang: preferredLang }),
      await timedtextJson3({ v: videoId }),
      await timedtextXml({ v: videoId, lang: preferredLang }),
      await timedtextXml({ v: videoId }),
      await timedtextVtt({ v: videoId, lang: preferredLang }),
      await timedtextVtt({ v: videoId })
    ].filter(Boolean);
    return { text: attempts[0] || '', tracks: [] };
  }

  const want = norm(preferredLang || '');
  const wantBase = base(want);
  const score = (t) =>
    (want && norm(t.lang_code) === want ? 4 : 0) +
    (wantBase && base(t.lang_code) === wantBase ? 2 : 0) +
    (t.kind !== 'asr' ? 1 : 0);

  tracks.sort((a, b) => score(b) - score(a));

  for (const tr of tracks) {
    const txt = await fetchUsingTrack(videoId, tr, null);
    if (txt) return { text: txt, tracks };
  }
  if (want) {
    for (const tr of tracks) {
      const txt = await fetchUsingTrack(videoId, tr, want);
      if (txt) return { text: txt, tracks };
    }
  }
  return { text: '', tracks };
}

export default async function handler(req, res) {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const { url, id, lang, debug } = req.query || {};
    const videoId = id || (url ? getVideoId(url) : null);
    if (!videoId) return res.status(400).json({ error: 'Missing or invalid ?url= or ?id=' });

    const tryLangs = [lang, 'en', 'en-US', 'en-GB', null].filter(Boolean);
    let result = { text: '', tracks: [] };
    for (const L of tryLangs) {
      result = await smartFetch(videoId, L);
      if (result.text) break;
    }

    if (debug === '1') {
      return res.status(result.text ? 200 : 404).json({
        ...(result.text ? { text: result.text } : { error: 'No transcript available' }),
        tracks: result.tracks,
        testedLangs: tryLangs
      });
    }

    if (!result.text) return res.status(404).json({ error: 'No transcript available' });
    return res.status(200).json({ text: result.text });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
