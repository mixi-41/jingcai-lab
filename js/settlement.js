import {
  HALF_FULL_LABELS,
  SCORE_SPECIAL_LABELS,
  STATUSES,
  nowIso
} from './schema.js';

const FINISHED = 'finished';

function outcome(homeGoals, awayGoals) {
  if (homeGoals > awayGoals) return 'home';
  if (homeGoals < awayGoals) return 'away';
  return 'draw';
}

function validGoals(value) {
  if (value === null || value === undefined || value === '') return false;
  return Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 99;
}

function selectionKeys(market) {
  const keys = new Set();
  for (const snapshot of market.snapshots || []) {
    for (const key of Object.keys(snapshot.odds || {})) keys.add(key);
  }
  return keys;
}

export function settleMarket(market, result) {
  if (!market) return null;
  if (result.status !== FINISHED) {
    return { winningSelection: null, settlementStatus: 'void', settledAt: nowIso() };
  }

  const homeGoals = Number(result.homeGoals);
  const awayGoals = Number(result.awayGoals);
  const hasScore = validGoals(homeGoals) && validGoals(awayGoals);
  if (!hasScore) {
    return { winningSelection: null, settlementStatus: 'pending', settledAt: nowIso() };
  }

  if (market.type === 'spf') {
    return { winningSelection: outcome(homeGoals, awayGoals), settlementStatus: 'settled', settledAt: nowIso() };
  }

  if (market.type === 'handicap') {
    const line = Number(market.line);
    if (!Number.isFinite(line)) {
      return { winningSelection: null, settlementStatus: 'pending', settledAt: nowIso() };
    }
    return {
      winningSelection: outcome(homeGoals + line, awayGoals),
      settlementStatus: 'settled',
      settledAt: nowIso()
    };
  }

  if (market.type === 'totals') {
    const total = homeGoals + awayGoals;
    return {
      winningSelection: total >= 7 ? '7+' : String(total),
      settlementStatus: 'settled',
      settledAt: nowIso()
    };
  }

  if (market.type === 'score') {
    const keys = selectionKeys(market);
    const exact = `${homeGoals}:${awayGoals}`;
    if (keys.has(exact)) {
      return { winningSelection: exact, settlementStatus: 'settled', settledAt: nowIso() };
    }
    const other = outcome(homeGoals, awayGoals) === 'home'
      ? 'other_home'
      : outcome(homeGoals, awayGoals) === 'away'
        ? 'other_away'
        : 'other_draw';
    if (keys.has(other)) {
      return { winningSelection: other, settlementStatus: 'settled', settledAt: nowIso() };
    }
    return { winningSelection: null, settlementStatus: 'pending', settledAt: nowIso() };
  }

  if (market.type === 'halfFull') {
    const htHomeRaw = result.htHome;
    const htAwayRaw = result.htAway;
    if (!validGoals(htHomeRaw) || !validGoals(htAwayRaw)) {
      return { winningSelection: null, settlementStatus: 'pending', settledAt: nowIso() };
    }
    const htHome = Number(htHomeRaw);
    const htAway = Number(htAwayRaw);
    const key = `${outcome(htHome, htAway)}_${outcome(homeGoals, awayGoals)}`;
    if (!HALF_FULL_LABELS[key]) {
      return { winningSelection: null, settlementStatus: 'pending', settledAt: nowIso() };
    }
    return { winningSelection: key, settlementStatus: 'settled', settledAt: nowIso() };
  }

  return { winningSelection: null, settlementStatus: 'pending', settledAt: nowIso() };
}

export function settleMatch(match, {
  homeGoals = null,
  awayGoals = null,
  htHome = null,
  htAway = null,
  status = FINISHED,
  note = ''
} = {}) {
  if (!match) throw new Error('比赛不存在');
  if (!STATUSES.includes(status)) throw new Error('赛果状态不合法');

  const isFinished = status === FINISHED;
  if (isFinished && (!validGoals(homeGoals) || !validGoals(awayGoals))) {
    throw new Error('全场比分必须是 0–99 的整数');
  }

  const hasHalf = validGoals(htHome) && validGoals(htAway);
  const result = {
    status,
    homeGoals: isFinished ? Number(homeGoals) : null,
    awayGoals: isFinished ? Number(awayGoals) : null,
    htHome: hasHalf ? Number(htHome) : null,
    htAway: hasHalf ? Number(htAway) : null,
    settledAt: nowIso(),
    note: String(note || '').trim()
  };

  const previous = match.result;
  const auditDetail = previous
    ? `修改赛果：${previous.homeGoals ?? '—'}:${previous.awayGoals ?? '—'} → ${result.homeGoals ?? '—'}:${result.awayGoals ?? '—'}`
    : `录入赛果：${status === FINISHED ? `${result.homeGoals}:${result.awayGoals}` : status}`;

  const markets = (match.markets || []).map((market) => {
    const settled = settleMarket(market, result);
    return { ...market, ...settled };
  });

  return {
    ...match,
    status,
    result,
    markets,
    audit: [
      ...(match.audit || []),
      { at: nowIso(), action: previous ? 'edit_result' : 'settle', detail: auditDetail }
    ],
    updatedAt: nowIso()
  };
}

export function settlementText(market) {
  if (!market?.winningSelection) {
    if (market?.settlementStatus === 'void') return '无效';
    if (market?.settlementStatus === 'pending') return '待结算';
    return '—';
  }
  if (market.type === 'score') {
    return SCORE_SPECIAL_LABELS[market.winningSelection] || market.winningSelection;
  }
  return market.winningSelection;
}

export function isResultPending(match, now = Date.now()) {
  if (!match || match.deletedAt) return false;
  if (match.status !== 'scheduled') return false;
  const kickoff = Date.parse(match.kickoff);
  return Number.isFinite(kickoff) && kickoff < now;
}
