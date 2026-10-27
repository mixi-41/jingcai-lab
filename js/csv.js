import {
  APP_ID,
  MARKET_TYPES,
  MARKET_LABELS,
  SCHEMA_VERSION,
  STATUSES,
  STATUS_LABELS,
  createId,
  formatMarketLabel,
  formatOdds,
  formatSelection,
  marketOrder,
  nowIso,
  toIso
} from './schema.js';

const COLUMNS = [
  'match_id',
  'home',
  'away',
  'league',
  'season',
  'round_label',
  'kickoff',
  'match_num',
  'status',
  'status_label',
  'home_goals',
  'away_goals',
  'ht_home',
  'ht_away',
  'market',
  'market_label',
  'line',
  'published_at',
  'captured_at',
  'is_closing',
  'selection',
  'selection_label',
  'odds',
  'market_result',
  'market_status',
  'updated_at'
];

function empty(value) {
  return value === null || value === undefined ? '' : value;
}

export function flattenMatches(matches = []) {
  const rows = [];
  const sorted = [...matches]
    .filter((match) => match && !match.deletedAt)
    .sort((a, b) => {
      const at = Date.parse(a.kickoff) || 0;
      const bt = Date.parse(b.kickoff) || 0;
      return at - bt;
    });

  for (const match of sorted) {
    const markets = [...(match.markets || [])].sort((a, b) => {
      const order = marketOrder(a.type) - marketOrder(b.type);
      return order || Number(a.line || 0) - Number(b.line || 0);
    });
    for (const market of markets) {
      const snapshots = [...(market.snapshots || [])].sort((a, b) => {
        const at = a.publishedAt ? Date.parse(a.publishedAt) : 0;
        const bt = b.publishedAt ? Date.parse(b.publishedAt) : 0;
        return at - bt;
      });
      for (const snapshot of snapshots) {
        for (const [selection, odds] of Object.entries(snapshot.odds || {})) {
          rows.push({
            match_id: match.matchId,
            home: match.home,
            away: match.away,
            league: match.league,
            season: match.season,
            round_label: match.roundLabel,
            kickoff: match.kickoff,
            match_num: match.matchNum,
            status: match.status,
            status_label: STATUS_LABELS[match.status] || match.status,
            home_goals: empty(match.result?.homeGoals),
            away_goals: empty(match.result?.awayGoals),
            ht_home: empty(match.result?.htHome),
            ht_away: empty(match.result?.htAway),
            market: market.type,
            market_label: formatMarketLabel(market.type, market.line),
            line: empty(market.line),
            published_at: empty(snapshot.publishedAt),
            captured_at: empty(snapshot.capturedAt),
            is_closing: snapshot.isClosing ? 'true' : 'false',
            selection,
            selection_label: formatSelection(market.type, selection, market.line),
            odds: formatOdds(odds),
            market_result: empty(market.winningSelection),
            market_status: empty(market.settlementStatus),
            updated_at: empty(match.updatedAt)
          });
        }
      }
    }
  }
  return rows;
}

function escapeCell(value) {
  const text = String(value ?? '');
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function toCsv(matches = []) {
  const rows = flattenMatches(matches);
  const lines = [COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(COLUMNS.map((column) => escapeCell(row[column])).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function csvFileName(date = new Date()) {
  const stamp = date.toISOString().slice(0, 10).replace(/-/g, '');
  return `jingcai-lab-${stamp}.csv`;
}

/**
 * 解析 CSV 文本，支持 UTF-8 BOM、CRLF、双引号转义和单元格内逗号/换行。
 * 这是导入用的最小解析器，不依赖第三方库。
 */
export function parseCsv(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
    } else if (char !== '\r') {
      cell += char;
    }
  }

  if (quoted) throw new Error('CSV 里有未闭合的双引号');
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function csvNumber(value, label, line) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`CSV 第 ${line} 行 ${label} 不是有效数字`);
  }
  return number;
}

function csvDate(value, label, line) {
  const iso = toIso(value, null);
  if (!iso) throw new Error(`CSV 第 ${line} 行 ${label} 不是有效时间`);
  return iso;
}

/**
 * 把 CSV 明细还原成 JSON 备份结构。
 * 一行 = 一场比赛 × 一个玩法 × 一个时间点 × 一个选项。
 * matchId 会保留；marketId/snapshotId 会重新生成。
 */
export function csvToSnapshot(text) {
  const rows = parseCsv(text).filter((cells) => cells.some((cell) => String(cell).trim() !== ''));
  if (rows.length < 2) throw new Error('CSV 为空或只有表头');

  const header = rows[0].map((cell) => String(cell).trim());
  const indexOf = new Map(header.map((name, index) => [name, index]));
  const required = ['match_id', 'home', 'away', 'market', 'selection', 'odds'];
  for (const column of required) {
    if (!indexOf.has(column)) throw new Error(`CSV 缺少列：${column}`);
  }

  const matchMap = new Map();

  for (let line = 1; line < rows.length; line += 1) {
    const cells = rows[line];
    const get = (name) => String(cells[indexOf.get(name)] ?? '').trim();

    const matchId = get('match_id');
    if (!matchId) throw new Error(`CSV 第 ${line} 行缺少 match_id`);

    let match = matchMap.get(matchId);
    if (!match) {
      const home = get('home');
      const away = get('away');
      if (!home || !away) throw new Error(`CSV 第 ${line} 行缺少主队或客队`);
      const kickoff = csvDate(get('kickoff'), 'kickoff', line);
      const status = STATUSES.includes(get('status')) ? get('status') : 'scheduled';
      const updatedAt = get('updated_at') ? csvDate(get('updated_at'), 'updated_at', line) : nowIso();
      const homeGoals = get('home_goals');
      const awayGoals = get('away_goals');
      let result = null;
      if (homeGoals !== '' || awayGoals !== '') {
        const homeNumber = csvNumber(homeGoals, 'home_goals', line);
        const awayNumber = csvNumber(awayGoals, 'away_goals', line);
        if (!Number.isInteger(homeNumber) || !Number.isInteger(awayNumber) || homeNumber < 0 || awayNumber < 0) {
          throw new Error(`CSV 第 ${line} 行比分必须是非负整数`);
        }
        const htHome = get('ht_home');
        const htAway = get('ht_away');
        result = {
          homeGoals: homeNumber,
          awayGoals: awayNumber,
          htHome: htHome === '' ? null : csvNumber(htHome, 'ht_home', line),
          htAway: htAway === '' ? null : csvNumber(htAway, 'ht_away', line),
          note: ''
        };
      }

      match = {
        schemaVersion: SCHEMA_VERSION,
        matchId,
        home,
        away,
        league: get('league') || '未分类',
        season: get('season'),
        roundLabel: get('round_label'),
        kickoff,
        matchNum: get('match_num'),
        note: '',
        status,
        result,
        markets: [],
        audit: [{ at: updatedAt, action: 'import-csv', detail: '从 CSV 导入' }],
        createdAt: updatedAt,
        updatedAt,
        deletedAt: null,
        marketsByKey: new Map()
      };
      matchMap.set(matchId, match);
    }

    const type = get('market');
    if (!MARKET_TYPES.includes(type)) throw new Error(`CSV 第 ${line} 行玩法无效：${type}`);
    const lineValue = get('line');
    if (type === 'handicap' && lineValue === '') {
      throw new Error(`CSV 第 ${line} 行让球玩法缺少 line`);
    }
    const handicapLine = type === 'handicap' ? csvNumber(lineValue, 'line', line) : null;
    const marketKey = `${type}|${handicapLine ?? ''}`;
    let market = match.marketsByKey.get(marketKey);
    if (!market) {
      market = {
        marketId: createId('mk'),
        type,
        line: handicapLine,
        snapshots: [],
        winningSelection: get('market_result') || null,
        settlementStatus: get('market_status') || (get('market_result') ? 'settled' : 'pending'),
        settledAt: get('market_status') === 'settled' ? (get('updated_at') || null) : null,
        createdAt: get('updated_at') || nowIso(),
        snapshotsByKey: new Map()
      };
      match.marketsByKey.set(marketKey, market);
    }

    const publishedAt = get('published_at') ? csvDate(get('published_at'), 'published_at', line) : null;
    const capturedAt = get('captured_at') ? csvDate(get('captured_at'), 'captured_at', line) : (publishedAt || nowIso());
    const isClosing = ['true', '1'].includes(get('is_closing').toLowerCase());
    const snapshotKey = `${publishedAt || ''}|${capturedAt}|${isClosing ? '1' : '0'}`;
    let snapshot = market.snapshotsByKey.get(snapshotKey);
    if (!snapshot) {
      snapshot = {
        snapshotId: createId('s'),
        publishedAt,
        capturedAt,
        isClosing,
        odds: {},
        rawText: '',
        source: 'csv-import'
      };
      market.snapshotsByKey.set(snapshotKey, snapshot);
    }

    const selection = get('selection');
    if (!selection) throw new Error(`CSV 第 ${line} 行缺少选项`);
    const odds = csvNumber(get('odds'), 'odds', line);
    if (odds <= 1) throw new Error(`CSV 第 ${line} 行赔率必须大于 1`);
    snapshot.odds[selection] = odds;
  }

  const matches = [...matchMap.values()].map(({ marketsByKey, ...match }) => ({
    ...match,
    markets: [...marketsByKey.values()].map(({ snapshotsByKey, ...market }) => ({
      ...market,
      snapshots: [...snapshotsByKey.values()]
    }))
  }));

  return {
    app: APP_ID,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: nowIso(),
    matches
  };
}

export { COLUMNS as CSV_COLUMNS, MARKET_TYPES };
