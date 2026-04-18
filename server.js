const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/calculator.html', (req, res) => res.sendFile(path.join(__dirname, 'calculator.html')));

const quoteCache = {};
app.get('/api/quote', async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'Symbol required' });
  const key = symbol.toUpperCase();
  const TWELVE_KEY = process.env.TWELVE_KEY;
  const cached = quoteCache[key];
  if (cached && Date.now() - cached.ts < 15000) return res.json(cached.data);
  try {
    const r = await fetch(`https://api.twelvedata.com/quote?symbol=${key}&apikey=${TWELVE_KEY}`);
    const q = await r.json();
    if (q.status === 'error' || !q.close) return res.status(404).json({ error: 'Symbol not found' });
    const data = { price: parseFloat(q.close), change_pct: parseFloat(q.percent_change) || 0, name: q.name || key, market_state: q.is_market_open ? 'REGULAR' : 'CLOSED' };
    quoteCache[key] = { data, ts: Date.now() };
    return res.json(data);
  } catch(e) { return res.status(500).json({ error: 'Server error' }); }
});

const newsCache = {};
app.get('/api/news', async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'Symbol required' });
  const key = symbol.toUpperCase();
  const FINNHUB_KEY = process.env.FINNHUB_KEY;
  if (!FINNHUB_KEY) return res.status(500).json({ error: 'News not configured' });
  const cached = newsCache[key];
  if (cached && Date.now() - cached.ts < 300000) return res.json(cached.data);
  const today = new Date(), from = new Date(today - 7*24*60*60*1000);
  const fmt = d => d.toISOString().split('T')[0];
  try {
    const r = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${key}&from=${fmt(from)}&to=${fmt(today)}&token=${FINNHUB_KEY}`);
    const articles = await r.json();
    const top3 = articles.filter(a => a.headline && a.url).slice(0, 3);
    const data = { articles: top3 };
    newsCache[key] = { data, ts: Date.now() };
    return res.json(data);
  } catch(e) { return res.status(500).json({ error: 'News unavailable' }); }
});

app.post('/api/risk', async (req, res) => {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Risk analysis not configured' });
  const { ticker, price, mode, cp, strike, premium, width, dte, iv, pop, ev, maxGain, maxLoss } = req.body;
  const tradeContext = `Ticker: ${ticker} at $${price}\nMode: ${mode} ${cp}\nStrike: $${strike}, Premium: $${premium}, Width: $${width||'N/A'}\nDTE: ${dte}, IV: ${iv}%\nPOP: ${(pop*100).toFixed(1)}%, EV: $${(ev*100).toFixed(2)}\nMax gain: $${maxGain!==null?(maxGain*100).toFixed(0):'Unlimited'}, Max loss: $${(maxLoss*100).toFixed(0)}`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 600,
        system: `Risk analyst for retail options app. Identify 3 specific risks for this trade in plain English. One sentence each, max 20 words. Return ONLY JSON: {"risks":[{"title":"...","detail":"..."},{"title":"...","detail":"..."},{"title":"...","detail":"..."}]}`,
        messages: [{ role: 'user', content: tradeContext }]
      })
    });
    const data = await r.json();
    const text = data.content?.[0]?.text || '{}';
    let parsed;
    try { parsed = JSON.parse(text); } catch(e) { const m = text.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : { risks: [] }; }
    return res.json(parsed);
  } catch(e) { return res.status(500).json({ error: 'Analysis failed' }); }
});

// ── IV Data from Polygon ─────────────────────────────
const ivCache = {};
app.get('/api/iv', async (req, res) => {
  const { symbol, strike, dte, cp } = req.query;
  if (!symbol) return res.status(400).json({ error: 'Symbol required' });
  const key = symbol.toUpperCase();
  const POLYGON_KEY = process.env.POLYGON_KEY;
  if (!POLYGON_KEY) return res.status(500).json({ error: 'IV data not configured' });

  const cacheKey = `${key}-${strike}-${dte}-${cp}`;
  const cached = ivCache[cacheKey];
  if (cached && Date.now() - cached.ts < 60000) return res.json(cached.data);

  try {
    // Get options chain snapshot
    const url = `https://api.polygon.io/v3/snapshot/options/${key}?limit=250&apiKey=${POLYGON_KEY}`;
    const r = await fetch(url);
    const json = await r.json();

    if (!json.results || !json.results.length) {
      return res.status(404).json({ error: 'No options data found' });
    }

    const targetStrike = parseFloat(strike) || 0;
    const targetDTE = parseInt(dte) || 30;
    const targetCP = (cp || 'call').toLowerCase();

    // Find target expiration date (closest to DTE)
    const today = new Date();
    const targetDate = new Date(today.getTime() + targetDTE * 24 * 60 * 60 * 1000);

    // Filter by contract type and find best match
    const contracts = json.results.filter(r =>
      r.details &&
      r.details.contract_type === targetCP &&
      r.implied_volatility > 0
    );

    if (!contracts.length) {
      return res.status(404).json({ error: 'No matching contracts found' });
    }

    // Score each contract by how close it is to target strike + target expiration
    const scored = contracts.map(c => {
      const expDate = new Date(c.details.expiration_date);
      const strikeDiff = Math.abs((c.details.strike_price || 0) - targetStrike);
      const dteDiff = Math.abs((expDate - today) / (24 * 60 * 60 * 1000) - targetDTE);
      return { ...c, score: strikeDiff * 2 + dteDiff * 0.5 };
    });

    scored.sort((a, b) => a.score - b.score);
    const best = scored[0];

    const iv = best.implied_volatility;
    const delta = best.greeks?.delta || null;
    const theta = best.greeks?.theta || null;
    const actualStrike = best.details.strike_price;
    const expiration = best.details.expiration_date;
    const bid = best.day?.close || null;

    // Also get IV for nearby strikes for context
    const nearbyIVs = scored.slice(0, 5).map(c => ({
      strike: c.details.strike_price,
      expiration: c.details.expiration_date,
      iv: Math.round(c.implied_volatility * 100)
    }));

    const data = {
      iv: Math.round(iv * 100),          // as percentage e.g. 75
      iv_raw: iv,                         // decimal e.g. 0.75
      delta: delta ? parseFloat(delta.toFixed(3)) : null,
      theta: theta ? parseFloat(theta.toFixed(4)) : null,
      strike: actualStrike,
      expiration,
      bid,
      nearby: nearbyIVs
    };

    ivCache[cacheKey] = { data, ts: Date.now() };
    return res.json(data);

  } catch(e) {
    console.error('Polygon IV error:', e);
    return res.status(500).json({ error: 'IV data unavailable' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`OPTS// v2 running on port ${PORT}`));
