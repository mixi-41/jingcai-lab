import { buildMarketSignals } from './signal.js';
import { formatMarketLabel, formatSelection, formatOdds } from './schema.js';

const OUTCOMES = ['home', 'draw', 'away'];
const OUTCOME_LABELS = { home: '主胜', draw: '平局', away: '客胜' };
const TIE_MARGIN = 3;
const MIN_SAMPLE = 20;

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function round4(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + Number(value), 0) / values.length : 0;
}

function percent(part, total) {
  return total > 0 ? round1((part / total) * 100) : 0;
}

function validGoals(value) {
  if (value === null || value === undefined || value === '') return false;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 99;
}

function hasResult(match) {
  return match?.status === 'finished'
    && validGoals(match?.result?.homeGoals)
    && validGoals(match?.result?.awayGoals);
}

function outcomeForSignal(match, signal) {
  if (!hasResult(match)) return null;
  const line = signal.marketType === 'handicap' ? Number(signal.line) || 0 : 0;
  const home = Number(match.result.homeGoals) + line;
  const away = Number(match.result.awayGoals);
  if (home > away) return 'home';
  if (home < away) return 'away';
  return 'draw';
}

function outcomeLabel(signal, key) {
  if (signal.marketType !== 'handicap') return OUTCOME_LABELS[key];
  return key === 'home' ? '让胜' : key === 'draw' ? '让平' : '让负';
}

function marketKey(signal) {
  return signal.marketType === 'handicap' ? `handicap:${signal.line}` : 'spf';
}

function matchIdOf(match) {
  return match?.matchId || match?.id || '';
}

function withinDays(match, range, now) {
  if (range === 'all') return true;
  const days = Number(range);
  if (!Number.isFinite(days) || days <= 0) return true;
  const time = Date.parse(match.kickoff || '');
  return Number.isFinite(time) && now - time <= days * 86400000;
}

function entryList(matches, filters) {
  const { league, range, status, marketKeys, strength, now } = filters;
  const selected = new Set(marketKeys || []);
  const entries = [];

  for (const match of matches) {
    if (!match || match.deletedAt) continue;
    if (league !== 'all' && (match.league || '未分类') !== league) continue;
    if (!withinDays(match, range, now)) continue;
    if (status === 'settled' && !hasResult(match)) continue;

    for (const signal of buildMarketSignals(match)) {
      if (selected.size && !selected.has(marketKey(signal))) continue;
      if (strength !== 'all' && signal.level !== strength) continue;
      const outcome = outcomeForSignal(match, signal);
      const tie = signal.marginPct < TIE_MARGIN;
      const favoriteKey = signal.favorite?.key || null;
      const hit = outcome && !tie && favoriteKey ? outcome === favoriteKey : null;
      entries.push({ match, signal, outcome, tie, hit, key: marketKey(signal) });
    }
  }

  return entries;
}

function groupCounts(entries, keyOf, labelOf) {
  const map = new Map();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (key === null || key === undefined) continue;
    const item = map.get(key) || { key, label: labelOf(entry), count: 0 };
    item.count += 1;
    map.set(key, item);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label), 'zh-CN'));
}

function performanceOf(entries) {
  const sample = entries.filter((entry) => entry.hit !== null && !entry.tie);
  const hits = sample.filter((entry) => entry.hit).length;
  const hitRate = percent(hits, sample.length);
  const avgPredicted = average(sample.map((entry) => Number(entry.signal.probabilities[entry.signal.favorite.key])));
  const profits = sample.map((entry) => (entry.hit ? Number(entry.signal.odds[entry.signal.favorite.key]) - 1 : -1));
  const brier = average(sample.map((entry) => {
    const actual = entry.outcome;
    return OUTCOMES.reduce((sum, key) => {
      const predicted = Number(entry.signal.probabilities[key]) / 100;
      return sum + ((predicted - (key === actual ? 1 : 0)) ** 2);
    }, 0) / 3;
  }));
  const logLoss = average(sample.map((entry) => {
    const predicted = Math.max(Number(entry.signal.probabilities[entry.outcome]) / 100, 1e-9);
    return -Math.log(predicted);
  }));

  return {
    sample: sample.length,
    hits,
    hitRate,
    avgPredicted: round1(avgPredicted),
    hitGap: round1(hitRate - avgPredicted),
    roi: round1(average(profits) * 100),
    avgOdds: round1(average(sample.map((entry) => Number(entry.signal.odds[entry.signal.favorite.key])))),
    brier: round4(brier),
    logLoss: round4(logLoss)
  };
}

function movementBucket(entries, direction) {
  const limit = 0.3;
  const bucket = entries.filter((entry) => {
    const move = Number(entry.signal.maxMovePct);
    if (!Number.isFinite(move)) return false;
    if (direction === 'up') return move > limit;
    if (direction === 'down') return move < -limit;
    return Math.abs(move) <= limit;
  });
  const sample = bucket.length;
  if (direction === 'flat') {
    return { sample, hits: null, hitRate: null, avgPredicted: null, hitGap: null, roi: null, avgOdds: null };
  }
  const hits = bucket.filter((entry) => entry.outcome === entry.signal.maxMoveKey).length;
  const hitRate = percent(hits, sample);
  const avgPredicted = average(bucket.map((entry) => Number(entry.signal.probabilities[entry.signal.maxMoveKey])));
  const profits = bucket.map((entry) => (entry.outcome === entry.signal.maxMoveKey
    ? Number(entry.signal.odds[entry.signal.maxMoveKey]) - 1
    : -1));
  return {
    sample,
    hits,
    hitRate,
    avgPredicted: round1(avgPredicted),
    hitGap: round1(hitRate - avgPredicted),
    roi: round1(average(profits) * 100),
    avgOdds: round1(average(bucket.map((entry) => Number(entry.signal.odds[entry.signal.maxMoveKey]))))
  };
}

function movementOf(entries) {
  const settled = entries.filter((entry) => entry.outcome
    && Number.isFinite(Number(entry.signal.maxMovePct)));
  const up = movementBucket(settled, 'up');
  const down = movementBucket(settled, 'down');
  const flat = movementBucket(settled, 'flat');
  return {
    sample: settled.length,
    buckets: { up, down, flat },
    avgAbsMove: round1(average(settled.map((entry) => Math.abs(Number(entry.signal.maxMovePct))))),
    levels: groupCounts(settled, (entry) => entry.signal.movementLevel, (entry) => entry.signal.movementLevel)
  };
}

function calibrationOf(entries) {
  const bins = [
    { label: '0–20%', min: 0, max: 20 },
    { label: '20–30%', min: 20, max: 30 },
    { label: '30–40%', min: 30, max: 40 },
    { label: '40–50%', min: 40, max: 50 },
    { label: '50%+', min: 50, max: 101 }
  ];
  return bins.map((bin) => {
    const binEntries = entries.filter((entry) => {
      if (entry.hit === null || entry.tie) return false;
      const p = Number(entry.signal.probabilities[entry.signal.favorite.key]);
      return p >= bin.min && p < bin.max;
    });
    const actual = percent(binEntries.filter((entry) => entry.hit).length, binEntries.length);
    const predicted = average(binEntries.map((entry) => Number(entry.signal.probabilities[entry.signal.favorite.key])));
    return {
      label: bin.label,
      sample: binEntries.length,
      predicted: round1(predicted),
      actual,
      gap: round1(actual - predicted)
    };
  });
}

function leagueRows(entries) {
  const map = new Map();
  for (const entry of entries) {
    if (entry.hit === null) continue;
    const league = String(entry.match.league || '').trim() || '未分类';
    const key = `${league}|${marketKey(entry.signal)}`;
    const row = map.get(key) || {
      league,
      marketLabel: entry.signal.marketLabel,
      line: entry.signal.line,
      sample: 0,
      hits: 0,
      hitRate: 0,
      avgPredicted: 0,
      hitGap: 0,
      roi: 0,
      avgOdds: 0,
      _predicted: [],
      _profits: [],
      _odds: []
    };
    if (!entry.tie) {
      row.sample += 1;
      if (entry.hit) row.hits += 1;
      row._predicted.push(Number(entry.signal.probabilities[entry.signal.favorite.key]));
      row._profits.push(entry.hit ? Number(entry.signal.odds[entry.signal.favorite.key]) - 1 : -1);
      row._odds.push(Number(entry.signal.odds[entry.signal.favorite.key]));
    }
    map.set(key, row);
  }
  return [...map.values()]
    .map((row) => {
      const predicted = average(row._predicted);
      return {
        league: row.league,
        marketLabel: row.marketLabel,
        line: row.line,
        sample: row.sample,
        hits: row.hits,
        hitRate: percent(row.hits, row.sample),
        avgPredicted: round1(predicted),
        hitGap: round1(percent(row.hits, row.sample) - predicted),
        roi: round1(average(row._profits) * 100),
        avgOdds: round1(average(row._odds))
      };
    })
    .sort((a, b) => b.sample - a.sample || a.league.localeCompare(b.league, 'zh-CN'));
}

export function buildSignalStats(matches, {
  league = 'all',
  range = 'all',
  status = 'settled',
  marketKeys = [],
  strength = 'all',
  now = Date.now()
} = {}) {
  const entries = entryList(matches || [], { league, range, status, marketKeys, strength, now });
  const settled = entries.filter((entry) => entry.outcome !== null);
  const matchesWithSignals = new Set(entries.map((entry) => matchIdOf(entry.match))).size;
  const matchesSettled = new Set(settled.map((entry) => matchIdOf(entry.match))).size;
  const performance = performanceOf(entries);
  const movement = movementOf(entries);
  const rows = leagueRows(settled);
  const calibration = calibrationOf(settled);

  return {
    generatedAt: now,
    scope: {
      league,
      range,
      status,
      marketKeys: [...(marketKeys || [])],
      strength,
      matches: matchesWithSignals,
      settledMatches: matchesSettled,
      samples: entries.length,
      settledSamples: settled.length,
      minSample: MIN_SAMPLE
    },
    overview: {
      avgReturn: round1(average(settled.map((entry) => Number(entry.signal.returnRatePct)))),
      avgOverround: round1(average(settled.map((entry) => Number(entry.signal.overroundPct)))),
      leagues: new Set(settled.map((entry) => String(entry.match.league || '').trim() || '未分类')).size,
      markets: new Set(settled.map((entry) => marketKey(entry.signal))).size,
      coverage: percent(settled.length, entries.length),
      pending: entries.length - settled.length,
      avgOdds: round1(average(settled.map((entry) => Number(entry.signal.odds[entry.signal.favorite.key]))))
    },
    distribution: {
      favorites: groupCounts(settled, (entry) => entry.signal.favorite?.key, (entry) => entry.signal.favorite?.label),
      levels: groupCounts(settled, (entry) => entry.signal.level, (entry) => entry.signal.level),
      markets: groupCounts(settled, (entry) => entry.key, (entry) => entry.signal.marketLabel)
    },
    performance,
    movement,
    rows,
    calibration,
    recent: [...entries]
      .sort((a, b) => (Date.parse(b.signal.latestAt || '') || 0) - (Date.parse(a.signal.latestAt || '') || 0))
      .slice(0, 10)
      .map((entry) => ({
        matchId: matchIdOf(entry.match),
        matchLabel: `${entry.match.home || '主队'} vs ${entry.match.away || '客队'}`,
        league: String(entry.match.league || '').trim() || '未分类',
        marketLabel: entry.signal.marketLabel,
        favoriteLabel: entry.signal.favorite?.label || '—',
        outcomeLabel: entry.outcome ? outcomeLabel(entry.signal, entry.outcome) : '待结算',
        probability: entry.signal.favorite ? entry.signal.probabilities[entry.signal.favorite.key] : null,
        odds: entry.signal.odds[entry.signal.favorite?.key] ?? null,
        hit: entry.hit,
        tie: entry.tie,
        at: entry.signal.latestAt
      })),
    quality: {
      missingResult: entries.length - settled.length,
      ties: settled.filter((entry) => entry.tie).length,
      singleSnapshot: entries.filter((entry) => entry.signal.single).length,
      noFavorite: entries.filter((entry) => !entry.signal.favorite).length
    }
  };
}

const KELLY_RETURN = 0.92;
const MIN_BUCKET_SAMPLE = 20;

const PROBABILITY_BUCKETS = [
  { key: '0_20', label: '0–20%', min: 0, max: 20 },
  { key: '20_30', label: '20–30%', min: 20, max: 30 },
  { key: '30_40', label: '30–40%', min: 30, max: 40 },
  { key: '40_50', label: '40–50%', min: 40, max: 50 },
  { key: '50_plus', label: '50%+', min: 50, max: 101 }
];

const DISPERSION_BUCKETS = [
  { key: 'lt15', label: '< 15%', test: (value) => value < 15 },
  { key: '15_30', label: '15–30%', test: (value) => value >= 15 && value < 30 },
  { key: '30_50', label: '30–50%', test: (value) => value >= 30 && value < 50 },
  { key: 'gte50', label: '≥ 50%', test: (value) => value >= 50 }
];

const ODDS_BUCKETS = [
  { key: 'lt150', label: '< 1.50', test: (value) => value < 1.50 },
  { key: '150_200', label: '1.50–2.00', test: (value) => value >= 1.50 && value < 2.00 },
  { key: '200_250', label: '2.00–2.50', test: (value) => value >= 2.00 && value < 2.50 },
  { key: 'gte250', label: '≥ 2.50', test: (value) => value >= 2.50 }
];

function metricOf(entry) {
  const skills = entry.signal;
  const probabilities = OUTCOMES.map((key) => Number(skills.probabilities[key]) / 100);
  const mean = average(probabilities);
  const deviation = Math.sqrt(average(probabilities.map((value) => (value - mean) ** 2)));
  const dispersion = mean > 0 ? (deviation / mean) * 100 : 0;
  const odds = OUTCOMES.map((key) => Number(skills.odds[key]));
  const averageOdds = average(odds);
  const kelly = Object.fromEntries(OUTCOMES.map((key) => [
    key,
    KELLY_RETURN * Number(skills.odds[key]) / averageOdds
  ]));
  const favoriteKey = skills.favorite?.key || null;
  return {
    kelly,
    dispersion: round1(dispersion),
    favoriteKelly: favoriteKey ? round4(kelly[favoriteKey]) : null,
    favoriteOdds: favoriteKey ? Number(skills.odds[favoriteKey]) : null,
    kellySpread: round4(Math.max(...Object.values(kelly)) - Math.min(...Object.values(kelly)))
  };
}

function metricBucketLabel(buckets, value) {
  return buckets.find((bucket) => bucket.test(value))?.label || '—';
}

const MARKET_OUTCOME_LABELS = {
  spf: { home: '主胜', draw: '平局', away: '客胜' },
  handicap: { home: '让胜', draw: '让平', away: '让负' }
};

export function buildMatchMetricRows(match) {
  return buildMarketSignals(match).map((signal) => {
    const metric = metricOf({ signal });
    const labels = MARKET_OUTCOME_LABELS[signal.marketType] || MARKET_OUTCOME_LABELS.spf;
    const actualKey = actualOutcomeKey(match, signal.line);
    const tendency = ['home', 'draw', 'away'].map((key) => {
      const market = Number(signal.probabilities?.[key] || 0);
      const actual = actualKey ? (actualKey === key ? 100 : 0) : null;
      return {
        key,
        label: labels[key],
        market,
        actual,
        difference: actual === null ? null : Math.round((actual - market) * 10) / 10
      };
    });
    return {
      marketKey: signal.marketType === 'handicap' ? `handicap:${signal.line}` : signal.marketType,
      marketLabel: signal.marketLabel,
      lineLabel: signal.lineLabel,
      labels,
      odds: signal.odds,
      kelly: metric.kelly,
      favoriteKey: signal.favorite?.key || null,
      favoriteLabel: signal.favorite?.label || null,
      favoriteKelly: metric.favoriteKelly,
      favoriteOdds: metric.favoriteOdds,
      dispersion: metric.dispersion,
      kellySpread: metric.kellySpread,
      dispersionBucket: metricBucketLabel(DISPERSION_BUCKETS, metric.dispersion),
      tendency
    };
  });
}

function actualOutcomeKey(match, line) {
  if (match.status !== 'finished') return null;
  const homeGoals = Number(match.result?.homeGoals);
  const awayGoals = Number(match.result?.awayGoals);
  if (!Number.isInteger(homeGoals) || !Number.isInteger(awayGoals)) return null;
  const adjustedHome = homeGoals + Number(line || 0);
  if (adjustedHome > awayGoals) return 'home';
  if (adjustedHome < awayGoals) return 'away';
  return 'draw';
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)))];
}

function dispersionPerformance(entries, test, label) {
  const all = entries.filter((entry) => test(entry.metric.dispersion));
  const settled = all.filter((entry) => entry.outcome && !entry.tie);
  return {
    label,
    count: all.length,
    ...performanceOf(all),
    reliable: settled.length >= MIN_BUCKET_SAMPLE
  };
}

function probabilityPerformance(entries, bucket) {
  const all = entries.filter((entry) => {
    if (!entry.outcome || entry.tie) return false;
    const favorite = entry.signal.favorite?.key;
    if (!favorite) return false;
    const probability = Number(entry.signal.probabilities[favorite]);
    return Number.isFinite(probability) && probability >= bucket.min && probability < bucket.max;
  });
  return {
    label: bucket.label,
    count: all.length,
    ...performanceOf(all),
    reliable: all.length >= MIN_BUCKET_SAMPLE
  };
}

function oddsBucketOf(value) {
  return ODDS_BUCKETS.find((bucket) => bucket.test(value)) || ODDS_BUCKETS[ODDS_BUCKETS.length - 1];
}

function leagueMetricRows(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const league = String(entry.match.league || '').trim() || '未分类';
    if (!groups.has(league)) groups.set(league, []);
    groups.get(league).push(entry);
  }
  return [...groups.entries()]
    .map(([league, group]) => ({
      league,
      sample: group.length,
      settled: group.filter((entry) => entry.outcome && !entry.tie).length,
      avgKelly: round1(average(group.map((entry) => entry.metric.favoriteKelly).filter((value) => value !== null))),
      avgDispersion: round1(average(group.map((entry) => entry.metric.dispersion))),
      ...performanceOf(group)
    }))
    .sort((a, b) => b.sample - a.sample || a.league.localeCompare(b.league, 'zh-CN'));
}

function oddsMetricRows(entries) {
  const groups = new Map(ODDS_BUCKETS.map((bucket) => [bucket.key, []]));
  for (const entry of entries) {
    if (entry.metric.favoriteOdds === null) continue;
    const bucket = oddsBucketOf(entry.metric.favoriteOdds);
    groups.get(bucket.key).push(entry);
  }
  return ODDS_BUCKETS.map((bucket) => {
    const group = groups.get(bucket.key);
    return {
      label: bucket.label,
      sample: group.length,
      settled: group.filter((entry) => entry.outcome && !entry.tie).length,
      avgKelly: round1(average(group.map((entry) => entry.metric.favoriteKelly).filter((value) => value !== null))),
      avgDispersion: round1(average(group.map((entry) => entry.metric.dispersion))),
      ...performanceOf(group)
    };
  });
}

/**
 * 相对价格/离散只做描述统计和分桶对赛果，不训练模型。
 * 相对价格固定以 92% 返还率为基准；离散是同一场三项去水概率的变异系数。
 */
export function buildMetricStats(matches, {
  league = 'all',
  range = 'all',
  status = 'settled',
  marketKeys = [],
  strength = 'all',
  now = Date.now()
} = {}) {
  const entries = entryList(matches || [], {
    league,
    range,
    status,
    marketKeys,
    strength,
    now
  });
  const enriched = entries.map((entry) => ({ ...entry, metric: metricOf(entry) }));
  const settled = enriched.filter((entry) => entry.outcome && !entry.tie);
  const dispersionValues = enriched.map((entry) => entry.metric.dispersion);
  const kellyValues = enriched.map((entry) => entry.metric.favoriteKelly).filter((value) => value !== null);
  const kellySpreads = enriched.map((entry) => entry.metric.kellySpread);
  const allKelly = enriched.flatMap((entry) => Object.values(entry.metric.kelly));
  const probabilityBuckets = PROBABILITY_BUCKETS.map((bucket) => probabilityPerformance(enriched, bucket));
  const dispersionBuckets = DISPERSION_BUCKETS.map((bucket) => ({
    label: bucket.label,
    ...dispersionPerformance(enriched, bucket.test, bucket.label)
  }));

  return {
    sample: enriched.length,
    settledSample: settled.length,
    matches: new Set(enriched.map((entry) => matchIdOf(entry.match))).size,
    scope: {
      league,
      range,
      status,
      marketKeys: [...(marketKeys || [])],
      strength,
      minSample: MIN_BUCKET_SAMPLE
    },
    kelly: {
      avgFavorite: round1(average(kellyValues)),
      avgAll: round1(average(allKelly)),
      avgSpread: round1(average(kellySpreads)),
      max: round1(Math.max(0, ...allKelly)),
      overOne: allKelly.filter((value) => value >= 1).length,
      overOnePct: percent(allKelly.filter((value) => value >= 1).length, allKelly.length)
    },
    dispersion: {
      avg: round1(average(dispersionValues)),
      median: round1(percentile(dispersionValues, 0.5)),
      p25: round1(percentile(dispersionValues, 0.25)),
      p75: round1(percentile(dispersionValues, 0.75)),
      max: round1(Math.max(0, ...dispersionValues)),
      buckets: dispersionBuckets
    },
    byLeague: leagueMetricRows(enriched),
    byOdds: oddsMetricRows(enriched),
    relationship: {
      probability: probabilityBuckets,
      dispersion: dispersionBuckets
    },
    quality: {
      ties: entries.filter((entry) => entry.tie).length,
      missingResult: entries.filter((entry) => !entry.outcome).length,
      singleSnapshot: entries.filter((entry) => entry.signal.single).length
    }
  };
}

export function listSignalMarkets(matches) {
  const map = new Map();
  for (const match of matches || []) {
    if (!match || match.deletedAt) continue;
    for (const signal of buildMarketSignals(match)) {
      const key = marketKey(signal);
      if (!map.has(key)) {
        map.set(key, {
          key,
          label: signal.marketType === 'handicap' ? `让球 ${signal.line > 0 ? '+' : ''}${signal.line}` : '常规盘',
          lineLabel: signal.lineLabel || '胜平负'
        });
      }
    }
  }
  return [...map.values()].sort((a, b) => {
    if (a.key === 'spf') return -1;
    if (b.key === 'spf') return 1;
    return Number(b.key.split(':')[1]) - Number(a.key.split(':')[1]);
  });
}

export function signalFilterLabel(market) {
  if (!market) return '全部盘口';
  return market.key === 'spf' ? '常规盘' : market.label;
}

export { MIN_SAMPLE };


const CLV_MARKET_TYPES = ['spf', 'handicap'];

function completeTriple(odds = {}) {
  return ['home', 'draw', 'away'].every((key) => Number(odds[key]) > 1);
}

function snapshotStamp(snapshot) {
  if (!snapshot?.publishedAt) return '未标时间';
  const date = new Date(snapshot.publishedAt);
  if (Number.isNaN(date.getTime())) return '未标时间';
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function closingOf(match, market) {
  const snapshots = [...(market.snapshots || [])]
    .filter((snapshot) => completeTriple(snapshot.odds))
    .sort((a, b) => (Date.parse(a.publishedAt) || 0) - (Date.parse(b.publishedAt) || 0));
  if (!snapshots.length) return null;
  const marked = snapshots.filter((snapshot) => snapshot.isClosing);
  if (marked.length) return { snapshot: marked[marked.length - 1], proxy: false };
  const cutoff = Date.parse(match.salesCutoffAt || match.kickoff || '');
  const eligible = Number.isFinite(cutoff)
    ? snapshots.filter((snapshot) => (Date.parse(snapshot.publishedAt) || 0) <= cutoff)
    : snapshots;
  const snapshot = eligible[eligible.length - 1] || snapshots[snapshots.length - 1];
  return { snapshot, proxy: true };
}

export function buildMatchClvRows(match = {}) {
  const rows = [];
  for (const market of match.markets || []) {
    if (!CLV_MARKET_TYPES.includes(market.type)) continue;
    const closeInfo = closingOf(match, market);
    if (!closeInfo) continue;
    const snapshots = [...(market.snapshots || [])]
      .filter((snapshot) => completeTriple(snapshot.odds))
      .sort((a, b) => (Date.parse(a.publishedAt) || 0) - (Date.parse(b.publishedAt) || 0))
      .map((snapshot) => ({
        snapshotId: snapshot.snapshotId,
        label: snapshotStamp(snapshot),
        publishedAt: snapshot.publishedAt || null
      }));
    const entry = snapshots.find((snapshot) => snapshot.snapshotId === market.entrySnapshotId) || null;
    const closing = closeInfo.snapshot;
    const entryAt = Date.parse(entry?.publishedAt || '');
    const closingAt = Date.parse(closing?.publishedAt || '');
    const entryAfterClosing = Number.isFinite(entryAt) && Number.isFinite(closingAt) && entryAt > closingAt;
    const values = ['home', 'draw', 'away'].map((key) => {
      const entryOdds = Number(entry ? (market.snapshots || []).find((s) => s.snapshotId === entry.snapshotId)?.odds?.[key] : NaN);
      const closingOdds = Number(closing.odds?.[key]);
      const valid = Number.isFinite(entryOdds) && entryOdds > 1 && Number.isFinite(closingOdds) && closingOdds > 1;
      const clvPct = valid ? Math.round((entryOdds / closingOdds - 1) * 1000) / 10 : null;
      return {
        key,
        label: formatSelection(market.type, key, market.line),
        entryOdds: valid ? entryOdds : null,
        closingOdds: valid ? closingOdds : null,
        clvPct
      };
    });
    rows.push({
      market,
      marketType: market.type,
      line: market.line,
      label: formatMarketLabel(market.type, market.line),
      snapshots,
      entry,
      closing: { snapshotId: closing.snapshotId, label: snapshotStamp(closing), publishedAt: closing.publishedAt || null },
      closingProxy: closeInfo.proxy,
      entryAfterClosing,
      values
    });
  }
  return rows;
}
