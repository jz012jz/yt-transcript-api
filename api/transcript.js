import { parseStringPromise } from 'xml2js';

// ---------- helpers ----------
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
const norm = (s) => (s || '').toLowerCase();
const base = (s) => norm(s).split('-')[0];
const UA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'Accept-Language': 'en,en-US;q=0.9'
};
function buildQuery(params) {
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

// ---------- caption helpers ----------
async function listTracks(videoId) {
  const url = 'https://www.youtube.com/api/timedtext?' + buildQuery({ type: 'list', v: videoId });
  const xml = await fetchText(url).catch(() => '');
  if (!xml || !xml.includes('<transcript_list')) return [];
  const parsed = await parseStringPromise(xml).catch(() => null);
  const tracks = parsed?.transcript_list?.track || [];
  return tracks.map(t => (
