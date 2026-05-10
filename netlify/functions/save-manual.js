const { getStore } = require('@netlify/blobs');

function scoreFed(cuts, firstCutDelivered) {
  if (cuts <= 0) return 0;
  if (firstCutDelivered || cuts >= 3) return 2;
  return 1;
}

function scoreCancellations(raw, declining) {
  if (raw == null) return 0;
  if (raw > 18 || !declining) return 0;
  if (raw <= 12 && declining) return 2;
  return 1;
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

const KEYS = ['mortgage', 'fedDirection', 'mba', 'nahb', 'cancellations', 'itbPB', 'osb'];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 };
  if (event.headers['x-refresh-token'] !== process.env.REFRESH_TOKEN) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const { signal } = body;
  if (!['fedDirection', 'cancellations', 'osb'].includes(signal)) {
    return { statusCode: 400, body: 'Unknown signal' };
  }

  const store = getStore({ name: 'dashboard', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_TOKEN });
  const existing = (await store.get('snapshot', { type: 'json' }).catch(() => null)) || { data: {}, totalScore: 0 };
  const data = { ...existing.data };
  const now = new Date().toISOString();

  if (signal === 'fedDirection') {
    const cuts = parseInt(body.cuts) || 0;
    const firstCutDelivered = !!body.firstCutDelivered;
    const value = `${cuts} ${cuts === 1 ? 'cut' : 'cuts'} priced${firstCutDelivered ? ' · first delivered' : ''}`;
    data.fedDirection = { cuts, firstCutDelivered, value, score: scoreFed(cuts, firstCutDelivered), lastUpdated: now, manual: true };
  } else if (signal === 'cancellations') {
    const raw = parseFloat(body.raw);
    const declining = !!body.declining;
    data.cancellations = { raw, declining, score: scoreCancellations(raw, declining), lastUpdated: now, manual: true };
  } else if (signal === 'osb') {
    const raw = parseFloat(body.raw);
    const prevRaw = existing.data?.osb?.raw ?? null;
    data.osb = { raw, prevRaw, score: scoreOSB(raw), lastUpdated: now, manual: true };
  }

  const totalScore = KEYS.reduce((sum, k) => sum + (data[k]?.score ?? 0), 0);
  const { action, tranche, names } = getAction(totalScore);

  const tripwires = {
    mortgageHigh: (data.mortgage?.raw ?? 0) > 6.75,
    osbLow: data.osb?.raw != null && data.osb.raw < 250,
    cancellationsHigh: data.cancellations?.raw != null && data.cancellations.raw > 18,
  };

  // Write history if score changed
  const prevScore = existing.totalScore ?? null;
  if (prevScore !== null && totalScore !== prevScore) {
    const history = (await store.get('history', { type: 'json' }).catch(() => null)) || [];
    history.unshift({
      ts: now,
      prevScore,
      newScore: totalScore,
      changes: [{ key: signal, prevScore: existing.data?.[signal]?.score ?? 0, newScore: data[signal].score }],
    });
    if (history.length > 90) history.length = 90;
    await store.set('history', JSON.stringify(history)).catch(() => {});
  }

  const snapshot = { ...existing, lastUpdated: now, data, totalScore, action, tranche, names: names || null, tripwires };
  await store.set('snapshot', JSON.stringify(snapshot));

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(snapshot),
  };
};
