const { getStore } = require('@netlify/blobs');

// ─── Scoring ──────────────────────────────────────────────────────────────────

function scoreMortgage(raw) {
  if (raw >= 6.75) return 0;
  if (raw < 6.0) return 2;
  return 1;
}

function scoreFed(cuts, firstCutDelivered) {
  if (cuts <= 0) return 0;
  if (firstCutDelivered || cuts >= 3) return 2;
  return 1;
}

function scoreMBA(raw) {
  if (raw >= 200) return 2;
  if (raw >= 145) return 1;
  return 0;
}

function scoreNAHB(raw) {
  if (raw >= 35) return 2;
  if (raw >= 20) return 1;
  return 0;
}

function scoreCancellations(raw, declining) {
  if (raw == null) return 0;
  if (raw > 18 || !declining) return 0;
  if (raw <= 12 && declining) return 2;
  return 1;
}

function scoreITBPB(raw) {
  if (raw <= 1.0) return 2;
  if (raw <= 1.5) return 1;
  return 0;
}

function scoreOSB(raw) {
  if (raw == null) return 0;
  if (raw > 400) return 2;
  if (raw >= 300) return 1;
  return 0;
}

function getAction(score) {
  if (score < 7)  return { action: 'Hold — wait', tranche: 0, names: null };
  if (score < 10) return { action: 'Tranche 1 — deploy 40%', tranche: 1, names: 'TOL + PHM' };
  if (score < 12) return { action: 'Tranche 2 — deploy 40%', tranche: 2, names: 'Add DHI + LEN' };
  return           { action: 'Tranche 3 — deploy final 20%', tranche: 3, names: 'Full position' };
}

function computeTripwires(data) {
  return {
    mortgageHigh: (data.mortgage?.raw ?? 0) > 6.75,
    osbLow: data.osb?.raw != null && data.osb.raw < 250,
    cancellationsHigh: data.cancellations?.raw != null && data.cancellations.raw > 18,
  };
}

// ─── Scraping ─────────────────────────────────────────────────────────────────

const AUTO_SIGNALS = [
  {
    key: 'mortgage',
    defaultUrl: 'https://www.freddiemac.com/pmms',
    prompt: 'This page shows the Freddie Mac Primary Mortgage Market Survey. Find the current 30-year fixed-rate mortgage average for this week. It will be a number like 6.37 or 6.81. Return ONLY the number — no percent sign, no other text.',
    validate: (n) => n > 2 && n < 15,
  },
  {
    key: 'mba',
    defaultUrl: 'https://tradingeconomics.com/united-states/mortgage-applications',
    prompt: 'This page shows MBA mortgage application data. Find the MBA Purchase Index value (not the Market Index or Refinance Index). It will be a number like 171.1 or 177.7. Return ONLY the number — no other text.',
    validate: (n) => n > 50 && n < 600,
  },
  {
    key: 'nahb',
    defaultUrl: 'https://www.nahb.org/news-and-economics/housing-economics/indices/housing-market-index',
    prompt: 'This page shows the NAHB/Wells Fargo Housing Market Index. Find the "Traffic of prospective buyers" sub-index value specifically — not the headline HMI number and not current sales. It will be a small number like 22 or 35. Return ONLY that number — no other text.',
    validate: (n) => n > 0 && n < 100,
  },
];

async function jinaFetch(url) {
  const resp = await fetch(`https://r.jina.ai/${url}`, {
    headers: { Accept: 'text/plain', 'X-Return-Format': 'text' },
    signal: AbortSignal.timeout(40000),
  });
  if (!resp.ok) throw new Error(`Jina HTTP ${resp.status}`);
  return resp.text();
}

async function extractWithHaiku(prompt, pageText, apiKey) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 32,
      messages: [{
        role: 'user',
        content: `${prompt}\n\n---BEGIN PAGE---\n${pageText.slice(0, 5000)}\n---END PAGE---\n\nReturn ONLY the number, nothing else.`,
      }],
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error(`Anthropic HTTP ${resp.status}`);
  const d = await resp.json();
  return d.content[0].text.trim();
}

// ─── Handler ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { statusCode: 500 };

  let store;
  try {
    store = getStore({ name: 'dashboard', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_TOKEN });
  } catch (err) {
    console.error('Blobs init failed:', err.message);
    return { statusCode: 500 };
  }

  const [existing, settings] = await Promise.all([
    store.get('snapshot', { type: 'json' }).catch(() => null),
    store.get('settings', { type: 'json' }).catch(() => null),
  ]);

  const prevData = existing?.data || {};
  const urls = settings || {};

  // Scrape 4 auto signals in parallel
  const results = await Promise.allSettled(
    AUTO_SIGNALS.map(async (sig) => {
      const url = urls[sig.key] || sig.defaultUrl;
      console.log(`[${sig.key}] fetching ${url}`);
      const pageText = await jinaFetch(url);
      console.log(`[${sig.key}] Jina OK, ${pageText.length} chars`);
      const extracted = await extractWithHaiku(sig.prompt, pageText, apiKey);
      console.log(`[${sig.key}] Haiku returned: "${extracted}"`);
      const raw = parseFloat(extracted.replace(/[,%$\s]/g, ''));
      if (isNaN(raw) || !sig.validate(raw)) throw new Error(`Validation failed: "${extracted}" → ${raw}`);
      return { key: sig.key, raw };
    })
  );

  // Build data object — start from existing to preserve manual signals
  const data = { ...prevData };
  const now = new Date().toISOString();

  results.forEach((result, i) => {
    const key = AUTO_SIGNALS[i].key;
    if (result.status === 'fulfilled') {
      const { raw } = result.value;
      const prevRaw = prevData[key]?.raw ?? null;
      console.log(`[${key}] success: ${raw} (prev: ${prevRaw})`);
      data[key] = { raw, prevRaw, lastUpdated: now, error: null, manual: false };
    } else {
      console.error(`[${key}] failed: ${result.reason.message}`);
      data[key] = { ...prevData[key], error: result.reason.message };
    }
  });

  // Compute auto signal scores
  if (data.mortgage?.raw != null) data.mortgage.score = scoreMortgage(data.mortgage.raw);
  if (data.mba?.raw != null)      data.mba.score      = scoreMBA(data.mba.raw);
  if (data.nahb?.raw != null)     data.nahb.score     = scoreNAHB(data.nahb.raw);

  // Re-score manual signals from stored values (in case scoring rules changed)
  if (!data.fedDirection) data.fedDirection = { cuts: 0, firstCutDelivered: false, score: 0, manual: true };
  else data.fedDirection.score = scoreFed(data.fedDirection.cuts ?? 0, data.fedDirection.firstCutDelivered ?? false);

  if (!data.cancellations) data.cancellations = { raw: null, declining: false, score: 0, manual: true };
  else data.cancellations.score = scoreCancellations(data.cancellations.raw, data.cancellations.declining);

  if (!data.itbPB) data.itbPB = { raw: null, score: 0, manual: true };
  else data.itbPB.score = scoreITBPB(data.itbPB.raw ?? null);

  if (!data.osb) data.osb = { raw: null, prevRaw: null, score: 0, manual: true };
  else data.osb.score = scoreOSB(data.osb.raw);

  const KEYS = ['mortgage', 'fedDirection', 'mba', 'nahb', 'cancellations', 'itbPB', 'osb'];
  const totalScore = KEYS.reduce((sum, k) => sum + (data[k]?.score ?? 0), 0);
  const { action, tranche, names } = getAction(totalScore);
  const tripwires = computeTripwires(data);

  console.log(`Total score: ${totalScore}/14 — ${action}`);

  const snapshot = { lastUpdated: now, data, totalScore, action, tranche, names: names || null, tripwires };

  // Write history only when totalScore changes
  const prevScore = existing?.totalScore ?? null;
  if (prevScore !== null && totalScore !== prevScore) {
    const history = (await store.get('history', { type: 'json' }).catch(() => null)) || [];
    const changes = KEYS
      .filter(k => (data[k]?.score ?? 0) !== (prevData[k]?.score ?? 0))
      .map(k => ({
        key: k,
        prevScore: prevData[k]?.score ?? 0,
        newScore: data[k]?.score ?? 0,
      }));
    history.unshift({ ts: now, prevScore, newScore: totalScore, changes });
    if (history.length > 90) history.length = 90;
    await store.set('history', JSON.stringify(history)).catch(err =>
      console.error('History write failed:', err.message)
    );
    console.log(`History updated — score ${prevScore} → ${totalScore}`);
  }

  await store.set('snapshot', JSON.stringify(snapshot));
  console.log('Snapshot written OK');

  return { statusCode: 200 };
};
