import {
  addAudit,
  formatFullDateTime,
  formatMarketLabel,
  formatSelection,
  nowIso
} from './schema.js';
import { settleMarket } from './settlement.js';

function text(value) {
  return String(value ?? '').trim();
}

function isoOrThrow(value, label) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw new Error(`${label}格式不正确`);
  return date.toISOString();
}

function same(a, b) {
  return String(a ?? '') === String(b ?? '');
}

export function validateEditFields({
  home,
  away,
  kickoff,
  salesCutoffAt = null,
  season = '',
  roundLabel = ''
} = {}) {
  const homeName = text(home);
  const awayName = text(away);
  if (!homeName || !awayName) throw new Error('主队和客队都不能为空');
  if (homeName === awayName) throw new Error('主队和客队不能相同');

  const kickoffIso = isoOrThrow(kickoff, '开赛时间');
  const cutoffIso = salesCutoffAt ? isoOrThrow(salesCutoffAt, '停售时间') : null;
  if (cutoffIso && Date.parse(cutoffIso) > Date.parse(kickoffIso)) {
    throw new Error('停售时间不能晚于开赛时间');
  }

  return {
    home: homeName,
    away: awayName,
    kickoff: kickoffIso,
    salesCutoffAt: cutoffIso,
    season: text(season),
    roundLabel: text(roundLabel)
  };
}

export function validateEditedMarkets(markets = [], { kickoff = null } = {}) {
  const kickoffTime = kickoff ? Date.parse(kickoff) : null;
  const seenMarkets = new Set();
  for (const market of markets) {
    if (!market.marketId) throw new Error('市场缺少 ID');
    if (market.type === 'handicap' && !Number.isInteger(Number(market.line))) {
      throw new Error('让球数必须是整数，例如 +2 或 -1');
    }
    const marketKey = `${market.type}:${market.type === 'handicap' ? Number(market.line) : ''}`;
    if (seenMarkets.has(marketKey)) {
      throw new Error(`同一场比赛不能有重复的${formatMarketLabel(market.type, market.line)}`);
    }
    seenMarkets.add(marketKey);
    for (const snapshot of market.snapshots || []) {
      if (!snapshot.snapshotId) throw new Error('时间点缺少 ID');
      const odds = Object.entries(snapshot.odds || {});
      if (!odds.length) throw new Error('时间点至少保留一个赔率');
      for (const [key, value] of odds) {
        const number = Number(value);
        if (!Number.isFinite(number) || number <= 1) {
          throw new Error(`${formatSelection(market.type, key, market.line)} 的赔率必须大于 1`);
        }
      }
      if (!snapshot.publishedAt) continue;
      const time = Date.parse(snapshot.publishedAt);
      if (Number.isNaN(time)) throw new Error('发布时间格式不正确');
      if (kickoffTime && time > kickoffTime) {
        throw new Error(`时间点 ${formatFullDateTime(snapshot.publishedAt)} 晚于开赛时间`);
      }
    }
  }
  return markets;
}

function snapshotLabel(market, snapshot) {
  const when = snapshot.publishedAt ? formatFullDateTime(snapshot.publishedAt) : '未标时间';
  return `${formatMarketLabel(market.type, market.line)} ${when}`;
}

function compareSnapshots(market, original, next) {
  const changes = [];
  const beforeTime = original.publishedAt ? formatFullDateTime(original.publishedAt) : '未标时间';
  const afterTime = next.publishedAt ? formatFullDateTime(next.publishedAt) : '未标时间';
  if (beforeTime !== afterTime) changes.push(`时间 ${beforeTime}→${afterTime}`);
  const keys = new Set([...Object.keys(original.odds || {}), ...Object.keys(next.odds || {})]);
  for (const key of keys) {
    const before = original.odds?.[key];
    const after = next.odds?.[key];
    if (same(before, after)) continue;
    changes.push(
      `${formatSelection(market.type, key, market.line)} ${before ?? '—'}→${after ?? '—'}`
    );
  }
  return changes;
}

export function applyMatchEdit(match, {
  fields = {},
  markets = [],
  reason = ''
} = {}) {
  if (!match) throw new Error('比赛不存在');
  if (match.result && !text(reason)) {
    throw new Error('这场比赛已经结算，修改必须填写原因');
  }

  const checkedFields = validateEditFields(fields);
  validateEditedMarkets(markets, { kickoff: checkedFields.kickoff });

  const nextFields = {
    ...checkedFields,
    league: text(fields.league) || '未分类',
    season: text(fields.season),
    roundLabel: text(fields.roundLabel),
    matchNum: text(fields.matchNum),
    note: text(fields.note)
  };

  const changes = [];
  for (const [key, label] of [
    ['home', '主队'],
    ['away', '客队'],
    ['league', '联赛'],
    ['season', '赛季'],
    ['roundLabel', '轮次'],
    ['kickoff', '开赛时间'],
    ['salesCutoffAt', '停售时间'],
    ['matchNum', '竞彩编号'],
    ['note', '备注']
  ]) {
    const before = match[key] ?? '';
    const after = nextFields[key] ?? '';
    if (!same(before, after)) {
      const displayBefore = key === 'kickoff' || key === 'salesCutoffAt'
        ? (before ? formatFullDateTime(before) : '空')
        : (before || '空');
      const displayAfter = key === 'kickoff' || key === 'salesCutoffAt'
        ? (after ? formatFullDateTime(after) : '空')
        : (after || '空');
      changes.push(`${label} ${displayBefore}→${displayAfter}`);
    }
  }

  const originalById = new Map((match.markets || []).map((market) => [market.marketId, market]));
  const nextById = new Map(markets.map((market) => [market.marketId, market]));

  for (const original of match.markets || []) {
    if (!nextById.has(original.marketId)) {
      changes.push(`删除玩法 ${formatMarketLabel(original.type, original.line)}`);
    }
  }

  const nextMarkets = markets.map((market) => {
    const original = originalById.get(market.marketId);
    if (!original) {
      changes.push(`新增玩法 ${formatMarketLabel(market.type, market.line)}`);
      return market;
    }
    if (!same(original.line, market.line)) {
      changes.push(`让球线 ${formatMarketLabel(original.type, original.line)}→${formatMarketLabel(market.type, market.line)}`);
    }
    const originalSnapshots = new Map((original.snapshots || []).map((snapshot) => [snapshot.snapshotId, snapshot]));
    const nextSnapshots = (market.snapshots || []).map((snapshot) => {
      const before = originalSnapshots.get(snapshot.snapshotId);
      if (!before) return snapshot;
      const diffs = compareSnapshots(market, before, snapshot);
      if (diffs.length) {
        changes.push(`编辑 ${snapshotLabel(market, before)}：${diffs.join('，')}`);
      }
      return snapshot;
    });
    for (const before of original.snapshots || []) {
      if (!nextSnapshots.some((snapshot) => snapshot.snapshotId === before.snapshotId)) {
        changes.push(`删除时间点 ${snapshotLabel(original, before)}`);
      }
    }
    return { ...market, snapshots: nextSnapshots };
  });

  // 已结算的比赛改赔率后自动重算，不新增“修改赛果”审计。
  const settledMarkets = match.result
    ? nextMarkets.map((market) => ({ ...market, ...settleMarket(market, match.result) }))
    : nextMarkets;

  const detail = changes.length
    ? `${changes.join('；')}${text(reason) ? `；原因：${text(reason)}` : ''}`
    : `编辑比赛（无字段变化）${text(reason) ? `；原因：${text(reason)}` : ''}`;

  return addAudit({
    ...match,
    ...nextFields,
    markets: settledMarkets,
    updatedAt: nowIso()
  }, 'edit_match', detail);
}
