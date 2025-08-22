import { YoutubeTranscript } from 'youtube-transcript';

export default async function handler(req, res) {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const { url, id, lang } = req.query || {};
    const videoUrl = url || (id ? `https://www.youtube.com/watch?v=${id}` : null);
    if (!videoUrl) {
      return res.status(400).json({ error: 'Missing ?url= or ?id=' });
    }

    const preferred = (lang || 'en').toLowerCase();
    let items = null;

    try {
      items = await YoutubeTranscript.fetchTranscript(videoUrl, { lang: preferred });
    } catch (_) {}

    if (!items || items.length === 0) {
      try {
        items = await YoutubeTranscript.fetchTranscript(videoUrl);
      } catch (_) {}
    }

    if (!items || items.length === 0) {
      return res.status(404).json({ error: 'No transcript available' });
    }

    const text = items.map(x => x.text).join(' ').replace(/\s+/g, ' ').trim();
    return res.status(200).json({ text, chunks: items });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
