import { MARKET_LABELS, MARKET_TYPES } from './schema.js';
import { buildMarketSignal } from './signal.js';
import { isResultPending } from './settlement.js';

const OUTCOMES = ['home', 'draw', 'away'];
const OUTCOME_LABELS = { home: '主胜', draw: '平局', away: '客胜' };

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
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

function validOdd(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 1;
}

function validTriple(odds) {
  return OUTCOMES.every((key) => validOdd(odds?.[key]));
}

function hasResult(match) {
  return match?.status === 'finished'
    && validGoals(match?.result?.homeGoals)
    && validGoals(match?.result?.awayGoals);
}

function resultOutcome(match) {
  if (!hasResult(match)) return null;
  const home = Number(match.result.homeGoals);
  const away = Number(match.result.awayGoals);
  if (home > away) return 'home';
  if (home < away) return 'away';
  return 'draw';
}

function marketHasOdds(market) {
  if (!market || !market.snapshots?.length) return false;
  return market.snapshots.some((snapshot) => {
    const odds = snapshot?.odds || {};
    if (market.type === 'spf' || market.type === 'handicap') return validTriple(odds);
    return Object.values(odds).some(validOdd);
  });
}

function matchHasOdds(match) {
  return (match?.markets || []).some(marketHasOdds);
}

function leagueOf(match) {
  return String(match?.league || '').trim() || '未分类';
}

function cutoffTime(match) {
  const cutoff = Date.parse(match?.salesCutoffAt || match?.kickoff || '');
  return Number.isFinite(cutoff) ? cutoff : null;
}

function selectedMarket(match) {
  const markets = match?.markets || [];
  const spf = markets.find((market) => market.type === 'spf');
  if (spf) return spf;
  return markets
    .filter((market) => market.type === 'handicap')
    .sort((a, b) => Math.abs(Number(a.line)) - Math.abs(Number(b.line)))[0] || null;
}

function hasExplicitClosing(match) {
  const market = selectedMarket(match);
  if (!market) return false;
  const cutoff = cutoffTime(match);
  return market.snapshots.some((snapshot) => {
    if (!snapshot?.isClosing || !validTriple(snapshot.odds)) return false;
    if (cutoff === null) return true;
    const at = Date.parse(snapshot.publishedAt || '');
    return Number.isFinite(at) && at <= cutoff;
  });
}

function snapshotCount(match) {
  return (match?.markets || []).reduce((sum, market) => sum + (market.snapshots?.length || 0), 0);
}

function duplicateSnapshots(match) {
  let duplicates = 0;
  for (const market of match?.markets || []) {
    const seen = new Set();
    for (const snapshot of market.snapshots || []) {
      const key = String(snapshot.publishedAt || '');
      if (!key) continue;
      if (seen.has(key)) duplicates += 1;
      else seen.add(key);
    }
  }
  return duplicates;
}

function buildCoverage(matches) {
  const rows = MARKET_TYPES.map((type) => {
    const count = matches.filter((match) => (match.markets || []).some((market) => market.type === type && marketHasOdds(market))).length;
    return {
      type,
      label: MARKET_LABELS[type] || type,
      matches: count,
      percent: percent(count, matches.length)
    };
  });
  return {
    rows,
    withOdds: matches.filter(matchHasOdds).length,
    percent: percent(matches.filter(matchHasOdds).length, matches.length)
  };
}

function buildPricing(signals) {
  const returns = signals.map((entry) => entry.signal.returnRatePct);
  const overrounds = signals.map((entry) => entry.signal.overroundPct);
  const favoriteCounts = { home: 0, draw: 0, away: 0, tie: 0 };
  for (const { signal } of signals) {
    const ranked = OUTCOMES
      .map((key) => ({ key, value: signal.probabilities[key] }))
      .sort((a, b) => b.value - a.value);
    if (Math.abs(ranked[0].value - ranked[1].value) < 0.05) favoriteCounts.tie += 1;
    else favoriteCounts[ranked[0].key] += 1;
  }
  return {
    sample: signals.length,
    avgReturnRatePct: round1(average(returns)),
    avgOverroundPct: round1(average(overrounds)),
    favoriteCounts,
    avgProbabilities: Object.fromEntries(OUTCOMES.map((key) => [
      key,
      round1(average(signals.map(({ signal }) => signal.probabilities[key])))
    ]))
  };
}

function buildMovement(signals) {
  const moves = signals.filter(({ signal }) => signal.sample >= 2);
  const avg = Object.fromEntries(OUTCOMES.map((key) => [
    key,
    round1(average(moves.map(({ signal }) => signal.movement[key])))
  ]));
  let up = 0;
  let down = 0;
  let flat = 0;
  for (const { signal } of moves) {
    if (signal.movement.home > 0.5) up += 1;
    else if (signal.movement.home < -0.5) down += 1;
    else flat += 1;
  }
  const biggest = moves
    .map(({ match, signal }) => ({
      label: `${match.home} vs ${match.away}`,
      league: leagueOf(match),
      at: signal.latestAt,
      market: signal.marketLabel,
      key: signal.maxMoveKey,
      labelText: signal.maxMoveLabel,
      delta: signal.maxMovePct
    }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 5);
  return {
    sample: moves.length,
    avg,
    up,
    down,
    flat,
    avgAbsMovePct: round1(average(moves.map(({ signal }) => Math.abs(signal.maxMovePct)))),
    biggest
  };
}

function buildResults(settled) {
  const outcomes = { home: 0, draw: 0, away: 0 };
  const goals = Array.from({ length: 8 }, (_, index) => ({ goals: index === 7 ? '7+' : String(index), count: 0 }));
  const scores = new Map();
  let totalGoals = 0;

  for (const match of settled) {
    const outcome = resultOutcome(match);
    if (!outcome) continue;
    outcomes[outcome] += 1;
    const home = Number(match.result.homeGoals);
    const away = Number(match.result.awayGoals);
    const total = home + away;
    totalGoals += total;
    const bucket = total >= 7 ? 7 : total;
    goals[bucket].count += 1;
    const score = `${home}:${away}`;
    scores.set(score, (scores.get(score) || 0) + 1);
  }

  return {
    sample: settled.length,
    outcomes,
    outcomePercents: Object.fromEntries(OUTCOMES.map((key) => [key, percent(outcomes[key], settled.length)])),
    totalGoals,
    avgGoals: settled.length ? round1(totalGoals / settled.length) : 0,
    goals: goals.map((row) => ({ ...row, percent: percent(row.count, settled.length) })),
    scores: [...scores.entries()]
      .map(([score, count]) => ({ score, count, percent: percent(count, settled.length) }))
      .sort((a, b) => b.count - a.count || a.score.localeCompare(b.score))
      .slice(0, 8)
  };
}

function buildLeagues(matches, signals) {
  const groups = new Map();
  for (const match of matches) {
    const league = leagueOf(match);
    if (!groups.has(league)) groups.set(league, { league, matches: [], signals: [], settled: [] });
    const group = groups.get(league);
    group.matches.push(match);
    if (hasResult(match)) group.settled.push(match);
  }
  for (const entry of signals) {
    const league = leagueOf(entry.match);
    const group = groups.get(league);
    if (group) group.signals.push(entry);
  }
  return [...groups.values()]
    .map((group) => {
      const outcomes = { home: 0, draw: 0, away: 0 };
      let goals = 0;
      for (const match of group.settled) {
        const outcome = resultOutcome(match);
        if (outcome) outcomes[outcome] += 1;
        goals += Number(match.result.homeGoals) + Number(match.result.awayGoals);
      }
      return {
        league: group.league,
        matches: group.matches.length,
        settled: group.settled.length,
        home: outcomes.home,
        draw: outcomes.draw,
        away: outcomes.away,
        homePct: percent(outcomes.home, group.settled.length),
        drawPct: percent(outcomes.draw, group.settled.length),
        awayPct: percent(outcomes.away, group.settled.length),
        avgGoals: group.settled.length ? round1(goals / group.settled.length) : 0,
        avgReturnRatePct: round1(average(group.signals.map(({ signal }) => signal.returnRatePct))),
        closingCoveragePct: percent(
          group.signals.filter(({ match, signal }) => signal.sample >= 2 || hasExplicitClosing(match)).length,
          group.signals.length
        )
      };
    })
    .sort((a, b) => b.matches - a.matches || a.league.localeCompare(b.league));
}

/**
 * 只读分析：从已录入的竞彩数据计算概览、覆盖率、定价、赛果、变化和联赛对比。
 * 不训练、不预测、不读取外部数据。
 */
export function buildAnalysisStats(matches, { now = Date.now() } = {}) {
  const active = (matches || []).filter((match) => match && !match.deletedAt);
  const signals = active
    .map((match) => ({ match, signal: buildMarketSignal(match) }))
    .filter((entry) => entry.signal);
  const settled = active.filter(hasResult);
  const pending = active.filter((match) => isResultPending(match, now));
  const closingSignals = signals.filter(({ match, signal }) => signal.sample >= 2 || hasExplicitClosing(match));
  const resultBase = active.filter((match) => match.status === 'finished' || isResultPending(match, now));
  const coverage = buildCoverage(active);

  const quality = {
    noOdds: active.length - coverage.withOdds,
    finishedWithoutScore: active.filter((match) => match.status === 'finished' && !hasResult(match)).length,
    pastUnsettled: pending.length,
    missingHalf: settled.filter((match) => !validGoals(match.result.htHome) || !validGoals(match.result.htAway)).length,
    missingCutoff: active.filter((match) => !match.salesCutoffAt).length,
    missingClosing: signals.filter(({ match, signal }) => signal.sample < 2 && !hasExplicitClosing(match)).length,
    duplicates: active.reduce((sum, match) => sum + duplicateSnapshots(match), 0)
  };

  return {
    generatedAt: new Date(now).toISOString(),
    overview: {
      matches: active.length,
      settled: settled.length,
      pending: pending.length,
      snapshots: active.reduce((sum, match) => sum + snapshotCount(match), 0),
      markets: active.reduce((sum, market) => sum + (market.markets?.length || 0), 0),
      leagues: new Set(active.map(leagueOf)).size,
      withOdds: coverage.withOdds,
      marketCoveragePct: coverage.percent,
      resultCoveragePct: percent(settled.length, resultBase.length),
      closingCoveragePct: percent(closingSignals.length, signals.length),
      avgReturnRatePct: round1(average(signals.map(({ signal }) => signal.returnRatePct))),
      avgOverroundPct: round1(average(signals.map(({ signal }) => signal.overroundPct))),
      avgSnapshots: active.length ? round1(active.reduce((sum, match) => sum + snapshotCount(match), 0) / active.length) : 0
    },
    coverage,
    pricing: buildPricing(signals),
    movement: buildMovement(signals),
    results: buildResults(settled),
    leagues: buildLeagues(active, signals),
    quality
  };
}

export { OUTCOME_LABELS };
