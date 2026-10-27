import { formatSelection } from './schema.js';

export const TOTAL_KEYS = ['0', '1', '2', '3', '4', '5', '6', '7+'];

// 与录入页的比分顺序保持一致，包含三个“其他”选项。
export const SCORE_KEYS = [
  '1:0', '2:0', '2:1', '3:0', '3:1', '3:2', '4:0', '4:1', '4:2', '5:0', '5:1', '5:2',
  '0:0', '1:1', '2:2', '3:3',
  '0:1', '0:2', '1:2', '0:3', '1:3', '2:3', '0:4', '1:4', '2:4', '0:5', '1:5', '2:5',
  'other_home', 'other_draw', 'other_away'
];

const SCORE_GROUPS = {
  home: ['1:0', '2:0', '2:1', '3:0', '3:1', '3:2', '4:0', '4:1', '4:2', '5:0', '5:1', '5:2', 'other_home'],
  draw: ['0:0', '1:1', '2:2', '3:3', 'other_draw'],
  away: ['0:1', '0:2', '1:2', '0:3', '1:3', '2:3', '0:4', '1:4', '2:4', '0:5', '1:5', '2:5', 'other_away']
};

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function parseTime(value) {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : null;
}

function cutoffTime(match) {
  return parseTime(match?.salesCutoffAt) ?? parseTime(match?.kickoff);
}

function validOdd(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 1;
}

function completeOdds(odds, keys) {
  return keys.every((key) => validOdd(odds?.[key]));
}

function latestSnapshot(market, cutoff, keys) {
  const snapshots = [...(market?.snapshots || [])]
    .filter((snapshot) => {
      if (cutoff === null) return true;
      const at = parseTime(snapshot.publishedAt);
      return at === null || at <= cutoff;
    })
    .sort((a, b) => (parseTime(a.publishedAt) ?? 0) - (parseTime(b.publishedAt) ?? 0));

  const latest = snapshots[snapshots.length - 1] || null;
  const complete = [...snapshots].reverse().find((snapshot) => completeOdds(snapshot.odds, keys)) || null;
  return {
    snapshot: complete || latest,
    latest,
    complete: Boolean(complete),
    sample: snapshots.length
  };
}

function normalize(odds, keys) {
  const implied = keys.map((key) => 1 / Number(odds[key]));
  const sum = implied.reduce((total, value) => total + value, 0);
  if (!Number.isFinite(sum) || sum <= 0) return null;
  return {
    sum,
    returnRatePct: round1(100 / sum),
    overroundPct: round1((sum - 1) * 100),
    probabilities: Object.fromEntries(keys.map((key, index) => [key, implied[index] / sum]))
  };
}

function buildTotals(market, cutoff) {
  const picked = latestSnapshot(market, cutoff, TOTAL_KEYS);
  if (!picked.snapshot) return { market: 'totals', missing: true };

  const normalized = normalize(picked.snapshot.odds, TOTAL_KEYS);
  if (!picked.complete || !normalized) {
    return {
      market: 'totals',
      incomplete: true,
      recorded: TOTAL_KEYS.filter((key) => validOdd(picked.snapshot.odds?.[key])).length,
      expected: TOTAL_KEYS.length,
      sample: picked.sample,
      latestAt: picked.snapshot.publishedAt || null
    };
  }

  const totalValue = (key) => key === '7+' ? 7 : Number(key);
  const overUnder = [1.5, 2.5, 3.5].map((line) => {
    const over = TOTAL_KEYS
      .filter((key) => totalValue(key) > line)
      .reduce((total, key) => total + normalized.probabilities[key], 0);
    return {
      line,
      overPct: round1(over * 100),
      underPct: round1((1 - over) * 100)
    };
  });

  return {
    market: 'totals',
    complete: true,
    sample: picked.sample,
    latestAt: picked.snapshot.publishedAt || null,
    returnRatePct: normalized.returnRatePct,
    overroundPct: normalized.overroundPct,
    options: TOTAL_KEYS.map((key) => ({
      key,
      label: formatSelection('totals', key),
      odds: Number(picked.snapshot.odds[key]),
      probabilityPct: round1(normalized.probabilities[key] * 100)
    })),
    overUnder
  };
}

function buildScore(market, cutoff) {
  const picked = latestSnapshot(market, cutoff, SCORE_KEYS);
  if (!picked.snapshot) return { market: 'score', missing: true };

  const normalized = normalize(picked.snapshot.odds, SCORE_KEYS);
  if (!picked.complete || !normalized) {
    return {
      market: 'score',
      incomplete: true,
      recorded: SCORE_KEYS.filter((key) => validOdd(picked.snapshot.odds?.[key])).length,
      expected: SCORE_KEYS.length,
      sample: picked.sample,
      latestAt: picked.snapshot.publishedAt || null
    };
  }

  const options = SCORE_KEYS.map((key) => ({
    key,
    label: formatSelection('score', key),
    odds: Number(picked.snapshot.odds[key]),
    probabilityPct: round1(normalized.probabilities[key] * 100)
  })).sort((a, b) => b.probabilityPct - a.probabilityPct);

  const groups = Object.fromEntries(['home', 'draw', 'away'].map((group) => [
    group,
    round1(SCORE_GROUPS[group].reduce((total, key) => total + normalized.probabilities[key], 0) * 100)
  ]));

  return {
    market: 'score',
    complete: true,
    sample: picked.sample,
    latestAt: picked.snapshot.publishedAt || null,
    returnRatePct: normalized.returnRatePct,
    overroundPct: normalized.overroundPct,
    top: options.slice(0, 8),
    groups
  };
}

/**
 * 从已录入的总进球/比分赔率反推市场隐含概率。
 * 只做去水换算，不训练、不推荐；赔率不完整时明确返回 incomplete。
 */
export function buildImpliedMarkets(match) {
  const markets = match?.markets || [];
  const cutoff = cutoffTime(match);
  const totalsMarket = markets.find((market) => market.type === 'totals');
  const scoreMarket = markets.find((market) => market.type === 'score');

  const totals = totalsMarket ? buildTotals(totalsMarket, cutoff) : null;
  const score = scoreMarket ? buildScore(scoreMarket, cutoff) : null;
  if (!totals && !score) return null;

  return { totals, score };
}
