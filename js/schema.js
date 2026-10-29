export const APP_ID = 'jingcai-lab';
export const SCHEMA_VERSION = 1;

export const MARKET_TYPES = ['spf', 'handicap', 'totals', 'score', 'halfFull'];

export const MARKET_LABELS = {
  spf: '胜平负',
  handicap: '让球胜平负',
  totals: '总进球',
  score: '比分',
  halfFull: '半全场'
};

export const MARKET_SHORT = {
  spf: '胜平负',
  handicap: '让球',
  totals: '总进球',
  score: '比分',
  halfFull: '半全场'
};

export const STATUSES = ['scheduled', 'finished', 'postponed', 'cancelled', 'abandoned'];

export const STATUS_LABELS = {
  scheduled: '待赛',
  finished: '已结算',
  postponed: '延期',
  cancelled: '取消',
  abandoned: '腰斩'
};

export const HALF_FULL_LABELS = {
  home_home: '胜胜',
  home_draw: '胜平',
  home_away: '胜负',
  draw_home: '平胜',
  draw_draw: '平平',
  draw_away: '平负',
  away_home: '负胜',
  away_draw: '负平',
  away_away: '负负'
};

export const SCORE_SPECIAL_LABELS = {
  other_home: '胜其他',
  other_draw: '平其他',
  other_away: '负其他'
};

export function nowIso() {
  return new Date().toISOString();
}

export function createId(prefix = 'id') {
  const uuid = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${uuid}`;
}

export function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function toIso(value, fallback = nowIso()) {
  if (!value) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

export function marketOrder(type) {
  const index = MARKET_TYPES.indexOf(type);
  return index === -1 ? 99 : index;
}

export function formatRoundLabel(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return /^\d+$/.test(text) ? `第${text}轮` : text;
}

export function formatCompetitionLabel(match = {}) {
  const season = String(match.season || '').trim();
  const league = String(match.league || '未分类').trim() || '未分类';
  const round = formatRoundLabel(match.roundLabel);
  return [season, league, round].filter(Boolean).join(' · ');
}

export function formatMarketLabel(type, line = null) {
  if (type === 'handicap') {
    const number = Number(line);
    if (Number.isFinite(number)) {
      return `让球 ${number > 0 ? '+' : ''}${number}`;
    }
    return MARKET_LABELS.handicap;
  }
  return MARKET_LABELS[type] || type;
}

export function formatSelection(type, selection, line = null) {
  if (type === 'spf' || type === 'handicap') {
    const prefix = type === 'handicap' ? '让' : '';
    if (selection === 'home') return `${prefix}胜`;
    if (selection === 'draw') return `${prefix}平`;
    if (selection === 'away') return `${prefix}负`;
  }
  if (type === 'totals') {
    return selection === '7+' ? '7+球' : `${selection}球`;
  }
  if (type === 'score') {
    return SCORE_SPECIAL_LABELS[selection] || selection;
  }
  if (type === 'halfFull') {
    return HALF_FULL_LABELS[selection] || selection;
  }
  return String(selection);
}

export function formatOdds(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : '—';
}

export function formatKickoff(iso, timeZone = 'Asia/Shanghai') {
  if (!iso) return '未设置';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '未设置';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(date).replace(/\//g, '-');
  } catch {
    return date.toLocaleString('zh-CN');
  }
}

export function formatFullDateTime(iso, timeZone = 'Asia/Shanghai') {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(date).replace(/\//g, '-');
  } catch {
    return date.toLocaleString('zh-CN');
  }
}

export function createSnapshot({
  publishedAt = null,
  capturedAt = nowIso(),
  odds = {},
  rawText = '',
  isClosing = false,
  source = 'paste',
  legacyLabel = null,
  legacySource = null
} = {}) {
  const cleanOdds = {};
  for (const [key, value] of Object.entries(odds)) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 1) {
      cleanOdds[key] = round2(number);
    }
  }
  return {
    snapshotId: createId('s'),
    publishedAt: publishedAt ? toIso(publishedAt) : null,
    capturedAt: toIso(capturedAt),
    isClosing: Boolean(isClosing),
    odds: cleanOdds,
    rawText: String(rawText || ''),
    source,
    legacyLabel: legacyLabel || null,
    legacySource: legacySource || null
  };
}

export function createMarket(type, { line = null, snapshots = [], entrySnapshotId = null } = {}) {
  if (!MARKET_TYPES.includes(type)) {
    throw new Error(`未知玩法：${type}`);
  }
  const normalizedLine = type === 'handicap' ? Number(line) : null;
  if (type === 'handicap' && !Number.isFinite(normalizedLine)) {
    throw new Error('让球玩法必须提供让球数');
  }
  return {
    marketId: createId('mk'),
    type,
    line: normalizedLine,
    snapshots: snapshots.map((snapshot) => createSnapshot(snapshot)),
    entrySnapshotId,
    winningSelection: null,
    settlementStatus: 'pending',
    settledAt: null,
    createdAt: nowIso()
  };
}

export function normalizeSnapshot(input = {}) {
  return {
    ...createSnapshot({
      publishedAt: input.publishedAt || null,
      capturedAt: input.capturedAt || nowIso(),
      odds: input.odds || {},
      rawText: input.rawText || '',
      isClosing: Boolean(input.isClosing),
      source: input.source || 'import',
      legacyLabel: input.legacyLabel || null,
      legacySource: input.legacySource || null
    }),
    // 编辑/导入时保留快照身份，避免每次读取都换一个新 ID。
    snapshotId: input.snapshotId || createId('s')
  };
}

export function normalizeMarket(input = {}) {
  const type = MARKET_TYPES.includes(input.type) ? input.type : null;
  if (!type) throw new Error(`未知玩法：${input.type}`);
  const line = type === 'handicap' ? Number(input.line) : null;
  if (type === 'handicap' && !Number.isFinite(line)) {
    throw new Error('让球玩法缺少让球数');
  }
  const snapshots = Array.isArray(input.snapshots)
    ? input.snapshots.map(normalizeSnapshot).sort((a, b) => {
      const at = a.publishedAt ? Date.parse(a.publishedAt) : 0;
      const bt = b.publishedAt ? Date.parse(b.publishedAt) : 0;
      return at - bt;
    })
    : [];
  return {
    marketId: input.marketId || createId('mk'),
    type,
    line,
    snapshots,
    entrySnapshotId: input.entrySnapshotId || null,
    winningSelection: input.winningSelection ?? null,
    settlementStatus: input.settlementStatus || (input.winningSelection ? 'settled' : 'pending'),
    settledAt: input.settledAt || null,
    createdAt: input.createdAt || nowIso()
  };
}

export function createMatch({
  home = '',
  away = '',
  league = '未分类',
  season = '',
  roundLabel = '',
  kickoff = nowIso(),
  salesCutoffAt = null,
  matchNum = '',
  note = '',
  matchId = createId('m')
} = {}) {
  const homeName = String(home).trim();
  const awayName = String(away).trim();
  if (!homeName || !awayName) {
    throw new Error('主队和客队都不能为空');
  }
  const at = nowIso();
  return {
    schemaVersion: SCHEMA_VERSION,
    matchId,
    home: homeName,
    away: awayName,
    league: String(league || '未分类').trim() || '未分类',
    season: String(season || '').trim(),
    roundLabel: String(roundLabel || '').trim(),
    kickoff: toIso(kickoff),
    salesCutoffAt: salesCutoffAt ? toIso(salesCutoffAt) : null,
    matchNum: String(matchNum || '').trim(),
    note: String(note || '').trim(),
    status: 'scheduled',
    result: null,
    markets: [],
    audit: [{ at, action: 'create', detail: '创建比赛' }],
    createdAt: at,
    updatedAt: at,
    deletedAt: null
  };
}

export function normalizeMatch(input = {}) {
  if (!input || typeof input !== 'object') throw new Error('比赛记录不是对象');
  const version = Number(input.schemaVersion || SCHEMA_VERSION);
  if (version > SCHEMA_VERSION) {
    throw new Error(`数据版本 ${version} 高于当前应用支持的 ${SCHEMA_VERSION}`);
  }
  const home = String(input.home || '').trim();
  const away = String(input.away || '').trim();
  if (!home || !away) throw new Error('比赛记录缺少主队或客队');
  const at = nowIso();
  const status = STATUSES.includes(input.status) ? input.status : 'scheduled';
  return {
    schemaVersion: SCHEMA_VERSION,
    matchId: input.matchId || createId('m'),
    home,
    away,
    league: String(input.league || '未分类').trim() || '未分类',
    season: String(input.season || '').trim(),
    roundLabel: String(input.roundLabel || '').trim(),
    kickoff: toIso(input.kickoff || at),
    salesCutoffAt: input.salesCutoffAt ? toIso(input.salesCutoffAt) : null,
    matchNum: String(input.matchNum || '').trim(),
    note: String(input.note || '').trim(),
    status,
    result: input.result && typeof input.result === 'object' ? input.result : null,
    markets: Array.isArray(input.markets) ? input.markets.map(normalizeMarket) : [],
    audit: Array.isArray(input.audit) ? input.audit.filter((item) => item && item.action) : [],
    legacy: input.legacy && typeof input.legacy === 'object' ? input.legacy : null,
    createdAt: input.createdAt || at,
    updatedAt: input.updatedAt || at,
    deletedAt: input.deletedAt || null
  };
}

export function addAudit(match, action, detail) {
  return {
    ...match,
    audit: [...(match.audit || []), { at: nowIso(), action, detail }],
    updatedAt: nowIso()
  };
}

export function findMarket(match, type, line = null) {
  const normalizedLine = type === 'handicap' ? Number(line) : null;
  return match.markets.find((market) => (
    market.type === type
    && (type !== 'handicap' || Number(market.line) === normalizedLine)
  ));
}

export function latestSnapshot(market) {
  if (!market?.snapshots?.length) return null;
  return [...market.snapshots].sort((a, b) => {
    const at = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const bt = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    return bt - at;
  })[0] || null;
}
