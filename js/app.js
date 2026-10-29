import {
  MARKET_LABELS,
  MARKET_SHORT,
  MARKET_TYPES,
  STATUS_LABELS,
  addAudit,
  createMarket,
  createMatch,
  createSnapshot,
  formatCompetitionLabel,
  formatFullDateTime,
  formatKickoff,
  formatMarketLabel,
  formatRoundLabel,
  formatOdds,
  formatSelection,
  latestSnapshot,
  marketOrder,
  nowIso
} from './schema.js';
import { mergeSnapshots, parsePaste } from './parse.js';
import { isResultPending, settleMarket, settleMatch } from './settlement.js';
import {
  clearMatches,
  countStats,
  exportSnapshot,
  getMatch,
  getSetting,
  importSnapshot,
  listMatches,
  putMatch,
  setLastExportAt,
  softDeleteMatch
} from './db.js';
import { csvFileName, csvToSnapshot, toCsv } from './csv.js';
import {
  buildCapabilityRows,
  capabilitySummary,
  computeCapabilityMetrics,
  percent
} from './capabilities.js';
import { buildMarketSignals } from './signal.js';
import { buildImpliedMarkets } from './implied.js';
import { buildAnalysisStats } from './stats.js';
import { buildMatchClvRows, buildMatchMetricRows, buildMetricStats, buildSignalStats, listSignalMarkets } from './signal-stats.js';
import { legacyToMatches } from './legacy-adapter.js';
import { applyMatchEdit, validateEditedMarkets, validateEditFields } from './edit.js';
import { APP_VERSION } from './version.js';

// 弹窗打开时锁住背后的页面，避免手机在弹窗边缘继续拖动整页。
function syncDialogScrollLock() {
  document.body.classList.toggle('dialog-open', Boolean(document.querySelector('dialog[open]')));
  updateBackToTop();
}

document.addEventListener('toggle', (event) => {
  if (event.target instanceof HTMLDialogElement) syncDialogScrollLock();
}, true);

// 部分手机浏览器会把整页横向拖动几像素；业务页面只允许纵向滚动。
let scrollUiFrame = 0;
function onPageScroll() {
  if (scrollUiFrame) return;
  scrollUiFrame = window.requestAnimationFrame(() => {
    scrollUiFrame = 0;
    updateBackToTop();
    updateMetricActive();
  });
}

window.addEventListener('scroll', () => {
  if (Math.abs(window.scrollX) > 1) {
    window.scrollTo({ left: 0, top: window.scrollY, behavior: 'instant' });
  }
  onPageScroll();
}, { passive: true });

const state = {
  matches: [],
  view: 'pending',
  search: '',
  status: 'all',
  activeMatch: null,
  lastExportAt: null,
  analysisTab: 'overview',
  analysisSeason: 'all',
  analysisLeague: 'all',
  analysisRound: 'all',
  analysisRange: 'all',
  analysisStatus: 'settled',
  analysisSearch: '',
  analysisMarkets: [],
  analysisStrength: 'all',
  dataSeason: 'all',
  dataLeague: 'all',
  dataRound: 'all',
  dataRange: 'all',
  dataSearch: ''
};

// 主导航/分析分段各自记忆滚动位置，不把一页的位置套到另一页。
const viewScrollMemory = new Map();
const analysisScrollMemory = new Map();
const ANALYSIS_TABS = ['overview', 'market', 'signal', 'results', 'quality', 'leagues'];
const METRIC_NAV = {
  market: [
    ['metric-market-pricing', '定价'],
    ['metric-market-movement', '变化'],
    ['metric-market-kelly', '相对价格/离散'],
    ['metric-market-probability', '热门概率'],
    ['metric-market-dispersion-buckets', '离散分桶'],
    ['metric-market-price-buckets', '热门赔率'],
    ['metric-market-league', '联赛']
  ],
  signal: [
    ['metric-signal-overview', '总览'],
    ['metric-signal-distribution', '热门分布'],
    ['metric-signal-performance', '命中收益'],
    ['metric-signal-movement', '变化方向'],
    ['metric-signal-league', '联赛×盘口'],
    ['metric-signal-calibration', '校准'],
    ['metric-signal-recent', '最近信号']
  ]
};
const ANALYSIS_ANCHOR_IDS = {
  定价水平: 'metric-market-pricing',
  '初盘 → 停售变化': 'metric-market-movement',
  相对价格与离散: 'metric-market-kelly',
  '热门概率分桶 × 赛果': 'metric-market-probability',
  '离散分桶 × 赛果': 'metric-market-dispersion-buckets',
  按热门赔率: 'metric-market-price-buckets',
  联赛指标: 'metric-market-league',
  热门分布: 'metric-signal-distribution',
  命中与收益: 'metric-signal-performance',
  最大波动方向: 'metric-signal-movement',
  '联赛 × 盘口': 'metric-signal-league',
  概率校准: 'metric-signal-calibration',
  最近信号: 'metric-signal-recent'
};
let lastActiveMetric = '';

const entryState = {
  match: null,
  cards: new Map(),
  dirty: false,
  returnToDetail: false
};

const editState = {
  match: null,
  newMarkets: [],
  removedMarketIds: [],
  dirty: false
};

const ENTRY_CARDS = [
  { type: 'spf', label: '胜平负', hint: '粘贴胜 / 平 / 负三项，支持多个发布时间。' },
  { type: 'handicap', label: '让球胜平负', hint: '先填让球数，再粘贴让胜 / 让平 / 让负。', line: true },
  { type: 'totals', label: '总进球', hint: '粘贴 0–7+ 共八项。' },
  { type: 'score', label: '比分', hint: '粘贴普通比分和胜其他 / 平其他 / 负其他。' },
  { type: 'halfFull', label: '半全场', hint: '粘贴胜胜到负负共九个组合。' }
];

const $ = (selector, root = document) => root.querySelector(selector);

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected') {
      node[key] = value;
    } else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function clear(node) {
  if (node) node.replaceChildren();
}

function toast(message, type = '') {
  const node = $('#toast');
  if (!node) return;
  node.textContent = message;
  node.className = `toast show${type ? ` ${type}` : ''}`;
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => {
    node.className = 'toast';
  }, 3200);
}

function localInputValue(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

const DT_PARTS = ['year', 'month', 'day', 'hour', 'minute'];
const DT_PAD = { year: 4, month: 2, day: 2, hour: 2, minute: 2 };

function dtContainer(prefix) {
  return document.querySelector(`[data-dt-fields="${prefix}"]`);
}

function clearDateTimeFields(prefix) {
  const container = dtContainer(prefix);
  if (!container) return;
  container.querySelectorAll('[data-dt-part]').forEach((input) => {
    input.value = '';
  });
  const hidden = container.parentElement?.querySelector('input[type="hidden"]');
  if (hidden) hidden.value = '';
}

function setDateTimeFields(prefix, value) {
  const container = dtContainer(prefix);
  if (!container) return;
  if (!value) {
    clearDateTimeFields(prefix);
    return;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    clearDateTimeFields(prefix);
    return;
  }
  const parts = {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes()
  };
  for (const part of DT_PARTS) {
    const input = container.querySelector(`[data-dt-part="${part}"]`);
    if (input) input.value = String(parts[part]).padStart(DT_PAD[part], '0');
  }
  const hidden = container.parentElement?.querySelector('input[type="hidden"]');
  if (hidden) hidden.value = localInputValue(date);
}

function readDateTimeFields(prefix, { required = false, label = '时间' } = {}) {
  const container = dtContainer(prefix);
  if (!container) throw new Error(`找不到${label}输入框`);
  const raw = {};
  for (const part of DT_PARTS) {
    const input = container.querySelector(`[data-dt-part="${part}"]`);
    raw[part] = input ? input.value.trim() : '';
  }
  const filled = DT_PARTS.filter((part) => raw[part] !== '');
  const hidden = container.parentElement?.querySelector('input[type="hidden"]');
  if (filled.length === 0) {
    if (hidden) hidden.value = '';
    if (required) throw new Error(`请填写${label}`);
    return null;
  }
  if (filled.length < DT_PARTS.length) {
    throw new Error(`${label}请把年、月、日、时、分填完整`);
  }
  const numbers = {};
  for (const part of DT_PARTS) {
    if (!/^\d+$/.test(raw[part])) throw new Error(`${label}只能填数字`);
    numbers[part] = Number(raw[part]);
  }
  if (numbers.year < 2000 || numbers.year > 2100) throw new Error(`${label}年份需在 2000–2100 之间`);
  if (numbers.month < 1 || numbers.month > 12) throw new Error(`${label}月份需在 1–12 之间`);
  if (numbers.day < 1 || numbers.day > 31) throw new Error(`${label}日期不正确`);
  if (numbers.hour > 23) throw new Error(`${label}小时需在 0–23 之间`);
  if (numbers.minute > 59) throw new Error(`${label}分钟需在 0–59 之间`);
  const daysInMonth = new Date(numbers.year, numbers.month, 0).getDate();
  if (numbers.day > daysInMonth) throw new Error(`${label}日期不存在`);
  const iso = `${String(numbers.year).padStart(4, '0')}-${String(numbers.month).padStart(2, '0')}-${String(numbers.day).padStart(2, '0')}T${String(numbers.hour).padStart(2, '0')}:${String(numbers.minute).padStart(2, '0')}`;
  if (hidden) hidden.value = iso;
  return iso;
}

function scorePair(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const match = text.match(/^(\d{1,2})\s*[-:：比]\s*(\d{1,2})$/);
  if (!match) throw new Error('比分格式应为 2-1，主队在前');
  const home = Number(match[1]);
  const away = Number(match[2]);
  if (home > 99 || away > 99) throw new Error('比分不能超过 99');
  return { home, away };
}

function updateSettlePreview() {
  const preview = $('#score-preview');
  const form = $('#settle-form');
  if (!preview || !form) return;
  const status = form.elements.status.value;
  if (status !== 'finished') {
    preview.textContent = '当前状态不结算比分。';
    return;
  }
  try {
    const full = scorePair(form.elements.fullScore.value);
    const half = scorePair(form.elements.halfScore.value);
    if (!full) {
      preview.textContent = '填写全场比分后自动识别，例如 2-1。';
      return;
    }
    if (half && (half.home > full.home || half.away > full.away)) {
      preview.textContent = '半场比分不能大于全场比分。';
      return;
    }
    preview.textContent = half
      ? `将按全场 ${full.home}:${full.away}、半场 ${half.home}:${half.away} 结算。`
      : `将按全场 ${full.home}:${full.away} 结算；半场未填，半全场待结算。`;
  } catch (error) {
    preview.textContent = error.message;
  }
}

function bindDateTimeInputs() {
  document.querySelectorAll('[data-dt-fields]').forEach((container) => {
    const inputs = [...container.querySelectorAll('[data-dt-part]')];
    inputs.forEach((input, index) => {
      const limit = Number(input.maxLength) || 2;
      input.addEventListener('input', () => {
        input.value = input.value.replace(/\D/g, '').slice(0, limit);
        if (input.value.length >= limit && inputs[index + 1]) inputs[index + 1].focus();
      });
      input.addEventListener('blur', () => {
        if (!input.value || input.dataset.dtPart === 'year') return;
        input.value = input.value.padStart(limit, '0');
      });
    });
  });
}

function localStamp(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 19).replace('T', ' ');
}

function closeDialog(dialog) {
  if (dialog?.open) dialog.close();
}

function showSubpage(id) {
  const page = $(`#${id}`);
  if (!page) return;
  page.hidden = false;
  page.scrollTop = 0;
  document.body.classList.add('subpage-open');
  updateBackToTop();
}

function hideSubpage(id) {
  const page = $(`#${id}`);
  if (page) page.hidden = true;
  if (!document.querySelector('.subpage:not([hidden])')) {
    document.body.classList.remove('subpage-open');
  }
  updateBackToTop();
}

function sortMarkets(markets = []) {
  return [...markets].sort((a, b) => {
    const order = marketOrder(a.type) - marketOrder(b.type);
    return order || Number(a.line || 0) - Number(b.line || 0);
  });
}

function selectionOrder(market) {
  if (market.type === 'spf' || market.type === 'handicap') return ['home', 'draw', 'away'];
  if (market.type === 'totals') return ['0', '1', '2', '3', '4', '5', '6', '7+'];
  if (market.type === 'halfFull') {
    return [
      'home_home', 'home_draw', 'home_away',
      'draw_home', 'draw_draw', 'draw_away',
      'away_home', 'away_draw', 'away_away'
    ];
  }
  if (market.type === 'score') {
    return [
      '1:0', '2:0', '2:1', '3:0', '3:1', '3:2', '4:0', '4:1', '4:2', '5:0', '5:1', '5:2',
      '0:0', '1:1', '2:2', '3:3',
      '0:1', '0:2', '1:2', '0:3', '1:3', '2:3', '0:4', '1:4', '2:4', '0:5', '1:5', '2:5',
      'other_home', 'other_draw', 'other_away'
    ];
  }
  return Object.keys(latestSnapshot(market)?.odds || {});
}

function sortedSelectionKeys(market, snapshot) {
  const keys = Object.keys(snapshot?.odds || {});
  const order = selectionOrder(market);
  return keys.sort((a, b) => {
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

function statusBadge(status) {
  return h('span', { class: `status ${status}` }, STATUS_LABELS[status] || status);
}

function resultText(match) {
  if (!match.result) return '';
  if (match.status !== 'finished') return STATUS_LABELS[match.status] || match.status;
  return `${match.result.homeGoals}:${match.result.awayGoals}`;
}

function hasPending(match) {
  return isResultPending(match);
}

function filteredMatches() {
  const needle = state.search.trim().toLowerCase();
  return state.matches.filter((match) => {
    if (match.deletedAt) return false;
    if (state.status !== 'all' && match.status !== state.status) return false;
    if (!needle) return true;
    return [match.home, match.away, match.league, match.season, match.roundLabel, match.matchNum, formatCompetitionLabel(match)]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });
}

function withinDays(match, range) {
  if (range === 'all') return true;
  const days = Number(range);
  if (!Number.isFinite(days)) return true;
  const kickoff = new Date(match.kickoff).getTime();
  if (!Number.isFinite(kickoff)) return false;
  return kickoff >= Date.now() - days * 24 * 60 * 60 * 1000;
}

function pendingMatches() {
  return state.matches.filter((match) => !match.deletedAt
    && (match.status === 'scheduled' || match.status === 'postponed' || hasPending(match)));
}

function settledMatches() {
  return state.matches.filter((match) => !match.deletedAt && Boolean(match.result));
}

function leagueOptions(matches, current) {
  const leagues = [...new Set(matches.map((match) => match.league).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  return [h('option', { value: 'all' }, '全部联赛'), ...leagues.map((league) =>
    h('option', { value: league, selected: league === current }, league)
  )];
}

function seasonOptions(matches, current) {
  const seasons = [...new Set(matches.map((match) => String(match.season || '').trim()).filter(Boolean))]
    .sort((a, b) => b.localeCompare(a, 'zh-CN'));
  const options = [h('option', { value: 'all' }, '全部赛季'),
    ...seasons.map((season) => h('option', { value: season, selected: season === current }, `${season} 赛季`))];
  if (matches.some((match) => !String(match.season || '').trim())) {
    options.push(h('option', { value: '__none__', selected: current === '__none__' }, '未标赛季'));
  }
  return options;
}

function roundOptions(matches, current, { season = 'all', league = 'all' } = {}) {
  const pool = matches.filter((match) => (
    (season === 'all' || (season === '__none__' ? !match.season : match.season === season))
    && (league === 'all' || match.league === league)
  ));
  const rounds = [...new Set(pool.map((match) => String(match.roundLabel || '').trim()).filter(Boolean))]
    .sort((a, b) => {
      const an = /^\d+$/.test(a) ? Number(a) : Infinity;
      const bn = /^\d+$/.test(b) ? Number(b) : Infinity;
      return an - bn || a.localeCompare(b, 'zh-CN');
    });
  const options = [h('option', { value: 'all' }, '全部轮次'),
    ...rounds.map((round) => h('option', {
      value: round,
      selected: round === current
    }, formatRoundLabel(round)))];
  if (pool.some((match) => !String(match.roundLabel || '').trim())) {
    options.push(h('option', { value: '__none__', selected: current === '__none__' }, '未标轮次'));
  }
  return options;
}

function matchesSeason(match, value) {
  if (value === 'all') return true;
  const season = String(match.season || '').trim();
  return value === '__none__' ? !season : season === value;
}

function matchesRound(match, value) {
  if (value === 'all') return true;
  const round = String(match.roundLabel || '').trim();
  return value === '__none__' ? !round : round === value;
}

function marketSummary(match) {
  const markets = sortMarkets(match.markets || []);
  if (!markets.length) {
    return h('span', { class: 'muted' }, '还没有赔率');
  }
  return h('div', { class: 'market-chips' }, markets.map((market) => h(
    'span',
    { class: 'chip' },
    formatMarketLabel(market.type, market.line),
    h('b', {}, market.snapshots?.length || 0)
  )));
}

function matchCard(match, { pendingView = false, collapsible = false } = {}) {
  const card = h('article', {
    class: `match-card${collapsible ? ' is-collapsed' : ''}`,
    tabindex: '0',
    role: 'button',
    'aria-expanded': collapsible ? 'false' : 'true',
    'aria-label': `${match.home} 对 ${match.away}`,
    onclick: (event) => {
      if (event.target.closest('button')) return;
      if (collapsible) {
        toggleCollapsed();
        return;
      }
      openDetail(match.matchId);
    },
    onkeydown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (collapsible) toggleCollapsed();
        else openDetail(match.matchId);
      }
    }
  });

  const main = h('div', { class: 'match-main' },
    h('div', { class: 'match-topline' },
      h('span', { class: 'league' }, formatCompetitionLabel(match)),
      match.matchNum ? h('span', { class: 'match-num' }, match.matchNum) : null
    ),
    h('h3', { class: 'match-teams' },
      h('span', {}, match.home),
      h('span', { class: 'vs' }, 'VS'),
      h('span', {}, match.away)
    ),
    h('div', { class: 'match-meta' },
      h('span', {}, formatKickoff(match.kickoff)),
      h('span', {}, `· ${match.markets?.length || 0} 个市场`),
      h('span', {}, `· ${(match.markets || []).reduce((sum, market) => sum + (market.snapshots?.length || 0), 0)} 个时间点`)
    ),
    marketSummary(match)
  );

  const needsSettlement = pendingView && (hasPending(match) || match.status === 'postponed');
  const toggle = collapsible
    ? h('button', {
      class: 'link-btn match-toggle',
      type: 'button',
      'aria-label': '展开比赛',
      onclick: (event) => {
        event.stopPropagation();
        toggleCollapsed();
      }
    }, '展开')
    : null;
  const side = h('div', { class: 'match-side' },
    statusBadge(match.status),
    match.status === 'finished' && match.result
      ? h('div', { class: 'match-result' }, resultText(match), h('small', {}, '90分钟'))
      : null,
    toggle,
    h('div', { class: 'match-actions' },
      h('button', {
        class: 'link-btn',
        type: 'button',
        onclick: () => openEditMatch(match.matchId)
      }, '编辑'),
      h('button', {
        class: 'card-action',
        type: 'button',
        onclick: () => (needsSettlement ? openSettleDialog(match) : openDetail(match.matchId))
      }, needsSettlement ? '录赛果' : '详情')
    )
  );

  function toggleCollapsed(force) {
    if (!collapsible) return;
    const open = typeof force === 'boolean' ? force : card.classList.contains('is-collapsed');
    card.classList.toggle('is-collapsed', !open);
    card.setAttribute('aria-expanded', String(open));
    if (toggle) {
      toggle.textContent = open ? '收起' : '展开';
      toggle.setAttribute('aria-label', open ? '收起比赛' : '展开比赛');
    }
  }

  card.append(main, side);
  return card;
}

function healthRows(stats) {
  const active = state.matches.filter((match) => !match.deletedAt);
  const pending = active.filter(hasPending).length;
  const noMarket = active.filter((match) => !match.markets?.length).length;
  const lastExport = state.lastExportAt
    ? formatFullDateTime(state.lastExportAt)
    : '从未导出';
  return [
    ['比赛', stats.matches, ''],
    ['已结算', stats.settled, stats.settled ? '' : 'warn'],
    ['待结算', pending, pending ? 'warn' : ''],
    ['时间点', stats.snapshots, ''],
    ['无赔率场次', noMarket, noMarket ? 'warn' : ''],
    ['最近导出', lastExport, state.lastExportAt ? '' : 'warn']
  ];
}

function renderHealth(stats) {
  const rows = healthRows(stats);
  const pill = $('#health-status');
  const warn = !state.lastExportAt || rows.some(([, , tone]) => tone === 'warn');
  pill.textContent = warn ? '待备份' : '本机';
  pill.classList.toggle('warn', warn);

  for (const id of ['health-body', 'data-health-body']) {
    const body = $(`#${id}`);
    if (!body) continue;
    clear(body);
    if (!state.matches.length) {
      body.append(h('p', { class: 'health-empty' }, '还没有数据。先新增一场比赛，数据健康会显示完整度。'));
      continue;
    }
    rows.forEach(([label, value, tone]) => {
      body.append(h('div', { class: 'health-row' },
        h('span', {}, label),
        h('b', { class: tone }, String(value))
      ));
    });
  }
}

function marketBreakdown() {
  const rows = MARKET_TYPES.map((type) => ({
    type,
    label: MARKET_LABELS[type] || type,
    markets: 0,
    snapshots: 0,
    matchIds: new Set()
  }));
  const byType = new Map(rows.map((row) => [row.type, row]));

  for (const match of state.matches) {
    if (match.deletedAt) continue;
    for (const market of match.markets || []) {
      const row = byType.get(market.type);
      if (!row) continue;
      row.markets += 1;
      row.snapshots += (market.snapshots || []).length;
      row.matchIds.add(match.matchId);
    }
  }

  return {
    rows,
    totalMarkets: rows.reduce((sum, row) => sum + row.markets, 0),
    totalSnapshots: rows.reduce((sum, row) => sum + row.snapshots, 0)
  };
}

function handleStatClick(kind) {
  if (kind === 'matches') {
    state.search = '';
    state.status = 'all';
    $('#search-input').value = '';
    $('#status-filter').value = 'all';
    switchView('matches');
    render();
    document.querySelector('.tabs')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return;
  }

  if (kind === 'pending') {
    switchView('pending');
    render();
    document.querySelector('.tabs')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

function svgNode(tag, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function sampleSnapshots(snapshots, max = 24) {
  if (snapshots.length <= max) return snapshots;
  const picked = [];
  for (let i = 0; i < max; i++) {
    picked.push(snapshots[Math.round((i * (snapshots.length - 1)) / (max - 1))]);
  }
  return [...new Set(picked)];
}

function trendSeries(match) {
  const markets = (match.markets || []).filter((market) => (
    (market.type === 'spf' || market.type === 'handicap')
    && (market.snapshots || []).length >= 2
  ));
  const market = markets.find((item) => item.type === 'spf') || markets[0];
  if (!market) return null;
  const snapshots = sampleSnapshots(market.snapshots.filter((snapshot) => (
    ['home', 'draw', 'away'].every((key) => Number(snapshot.odds?.[key]) > 1)
  )));
  if (snapshots.length < 2) return null;
  return { market, snapshots };
}

function renderTrend() {
  const body = $('#trend-body');
  const meta = $('#trend-meta');
  clear(body);
  const candidates = state.matches
    .filter((match) => !match.deletedAt && (match.markets || []).some((market) => (market.snapshots || []).length >= 2))
    .sort((a, b) => new Date(b.updatedAt || b.kickoff) - new Date(a.updatedAt || a.kickoff));
  const match = candidates[0];
  const series = match ? trendSeries(match) : null;
  if (!series) {
    meta.textContent = '等待数据';
    body.append(h('div', { class: 'trend-empty' }, '保存两场或两个时间点后，这里会显示同一玩法的赔率走势。'));
    return;
  }

  const { market, snapshots } = series;
  const width = 640;
  const height = 132;
  const pad = 12;
  const keys = ['home', 'draw', 'away'];
  const values = snapshots.flatMap((snapshot) => keys.map((key) => Number(snapshot.odds[key])));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (index) => pad + (index / (snapshots.length - 1)) * (width - pad * 2);
  const y = (value) => height - pad - ((value - min) / span) * (height - pad * 2);
  const colors = { home: 'var(--accent)', draw: '#c08a5a', away: '#6d7f9c' };
  const labels = { home: '主胜', draw: '平', away: '客胜' };

  const svg = svgNode('svg', {
    class: 'trend-chart',
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': `${match.home} 对 ${match.away} 的赔率走势`
  });
  for (const value of [0, 0.5, 1]) {
    svg.append(svgNode('line', {
      x1: pad,
      x2: width - pad,
      y1: pad + value * (height - pad * 2),
      y2: pad + value * (height - pad * 2),
      stroke: 'color-mix(in srgb, var(--line) 70%, transparent)',
      'stroke-width': 1
    }));
  }
  for (const key of keys) {
    const points = snapshots.map((snapshot, index) => `${x(index).toFixed(1)},${y(Number(snapshot.odds[key])).toFixed(1)}`);
    svg.append(svgNode('polyline', {
      points: points.join(' '),
      fill: 'none',
      stroke: colors[key],
      'stroke-width': 2.5,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round'
    }));
  }
  const latest = snapshots.at(-1);
  for (const key of keys) {
    svg.append(svgNode('circle', {
      cx: x(snapshots.length - 1),
      cy: y(Number(latest.odds[key])),
      r: 3,
      fill: 'var(--surface)',
      stroke: colors[key],
      'stroke-width': 2
    }));
  }

  meta.textContent = `${match.home} vs ${match.away} · ${MARKET_LABELS[market.type] || market.type}`;
  body.append(svg);
  body.append(h('div', { class: 'trend-legend' },
    ...keys.map((key) => h('span', {},
      h('i', { style: `background:${colors[key]}` }),
      `${labels[key]} ${formatOdds(latest.odds[key])}`
    ))
  ));
  const first = snapshots[0];
  body.append(h('div', { class: 'trend-caption' },
    h('span', {}, `${snapshots.length} 个时间点 · ${formatFullDateTime(first.publishedAt || first.capturedAt)}`),
    h('b', {}, `主胜 ${formatOdds(latest.odds.home)}`)
  ));
}

function renderDashboard(stats) {
  renderHealth(stats);
  renderTrend();
}

function renderMarketStrip() {
  const strip = $('#market-strip');
  if (!strip) return;
  const summary = marketBreakdown();
  clear(strip);
  if (state.view !== 'matches' || !summary.totalMarkets) {
    strip.hidden = true;
    return;
  }
  strip.hidden = false;
  for (const row of summary.rows.filter((item) => item.markets > 0)) {
    strip.append(h('span', { class: 'market-strip-chip' },
      h('span', {}, row.label),
      h('b', {}, String(row.markets))
    ));
  }
}

function capabilityCard(row, metrics) {
  const statusLabel = row.status === 'ready'
    ? (row.implemented ? '已接入' : '样本已够 · 待接入')
    : row.status === 'warn'
      ? '待补质量'
      : '未开放';
  const leagueNote = row.id === 'league' ? ` · ${metrics.maxLeague}` : '';
  return h('article', { class: `cap-card ${row.status}` },
    h('div', { class: 'cap-head' },
      h('div', { class: 'cap-title' },
        h('h3', {}, row.title),
        h('p', {}, row.subtitle)
      ),
      h('span', { class: 'cap-status' }, statusLabel)
    ),
    h('div', {
      class: 'cap-progress',
      role: 'progressbar',
      'aria-label': `${row.title} 数据进度`,
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': String(row.percent)
    }, h('span', { style: `width:${row.percent}%` })),
    h('div', { class: 'cap-meta' },
      h('span', {}, `${row.countLabel}：${row.count}/${row.threshold}${leagueNote}`),
      h('b', {}, row.missing)
    ),
    row.quality
      ? h('div', { class: 'cap-quality-line' },
          `${row.quality.label} ${percent(row.quality.value)}%`,
          h('span', {}, ` / 要求 ≥${percent(row.quality.gate)}%`)
        )
      : null,
    h('p', { class: 'cap-note' }, row.note)
  );
}

function qualityRow(label, value, gate) {
  const valuePercent = percent(value);
  return h('div', { class: 'cap-quality-row' },
    h('div', { class: 'cap-quality-label' },
      h('span', {}, label),
      h('b', {}, `${valuePercent}%`),
      h('small', {}, `目标 ≥${percent(gate)}%`)
    ),
    h('div', { class: 'cap-quality-bar' },
      h('span', { class: value >= gate ? 'pass' : '', style: `width:${valuePercent}%` })
    )
  );
}

function renderCapabilities() {
  const metrics = computeCapabilityMetrics(state.matches);
  const rows = buildCapabilityRows(metrics);
  const summary = capabilitySummary(rows);

  const summaryNode = $('#cap-summary');
  clear(summaryNode);
  summaryNode.append(
    h('article', { class: 'cap-summary-card' },
      h('span', {}, '已达标'),
      h('strong', {}, `${summary.ready} / ${summary.total}`),
      h('small', {}, summary.ready
        ? `${summary.ready} 项达标 · ${summary.implemented} 项已接入`
        : summary.warn ? `${summary.warn} 项待补质量` : '全部数据待积累')
    ),
    h('article', { class: 'cap-summary-card' },
      h('span', {}, '已结算'),
      h('strong', {}, String(metrics.settled)),
      h('small', {}, `共 ${metrics.matches} 场`)
    ),
    h('article', { class: 'cap-summary-card' },
      h('span', {}, '收盘/赛前样本'),
      h('strong', {}, String(metrics.closing)),
      h('small', {}, `${percent(metrics.closingCoverage)}% 覆盖`)
    )
  );

  const qualityNode = $('#cap-quality');
  clear(qualityNode);
  qualityNode.append(
    h('div', { class: 'cap-quality-head' },
      h('div', {},
        h('p', { class: 'eyebrow' }, 'DATA QUALITY'),
        h('h3', {}, '质量门槛')
      ),
      h('span', { class: 'muted' }, '数量够 ≠ 数据完整')
    ),
    qualityRow('赛果完整率', metrics.resultCoverage, 0.95),
    qualityRow('收盘/赛前快照覆盖', metrics.closingCoverage, 0.9),
    qualityRow('有赔率比赛占比', metrics.marketCoverage, 0.8)
  );

  const grid = $('#cap-grid');
  clear(grid);
  rows.forEach((row) => grid.append(capabilityCard(row, metrics)));
}

function analysisPanel(title, eyebrow, ...children) {
  return h('article', { class: 'panel analysis-panel' },
    h('div', { class: 'analysis-panel-head' },
      h('div', {},
        h('p', { class: 'eyebrow' }, eyebrow),
        h('h3', {}, title)
      )
    ),
    ...children
  );
}

const METRIC_EXPLAIN = {
  比赛: '当前筛选下已录入的比赛数，包含已结算和待结算。',
  已结算: '有 90 分钟赛果、可以进入赛果统计的比赛数。',
  时间点: '所有玩法保存的赔率快照总数；不同玩法更新频率不同，不能只按数量判断完整度。',
  平均返还率: '每场取收盘/停售前最后一条完整胜平负快照，按 100 / Σ(1/赔率) 计算后取平均。',
  '收盘/赛前覆盖': '有收盘标记，或有停售/开赛前至少两个时间点的比赛占比。',
  无赔率场次: '已建比赛但还没有任何赔率快照。',
  完赛缺比分: '状态为已结束，但没有完整的 90 分钟主客队比分。',
  过时未结算: '开赛时间已过，但仍没有录入赛果。',
  缺停售时间: '没有填写停售时间，收盘判断只能用开赛时间代理。',
  '缺收盘/赛前': '有赔率，但没有可用的收盘/停售前快照。',
  重复发布时间: '同一玩法有多条完全相同发布时间的快照，可能重复粘贴。',
  有效样本: '有完整胜平负三项赔率、可以参与定价统计的比赛数。',
  平均抽水: '每场 (Σ(1/赔率) - 1) 的平均值；数值越高，庄家理论抽水越高。',
  可比较样本: '至少有两个时间点、可以计算初盘到停售变化的比赛数。',
  平均绝对变化: '主胜、平、客胜三项去水概率变化的绝对值之和除以 2，单位百分点。',
  '主胜升温/降温/平稳': '主胜去水概率上升 / 下降 / 变化小于 0.1 个百分点的场次数。',
  场均进球: '已结算比赛的 90 分钟总进球平均值。',
  相对价格均值: '热门项的相对价格平均值；固定用 92% 返还率：0.92 × 赔率 / 三项平均赔率。',
  相对价格极差: '同一场三项相对价格的最大值减最小值，越大表示三项分歧越明显。',
  离散均值: '每场三项去水概率的标准差除以均值，再取平均；只衡量单场三项是否均衡。',
  离散中位: '离散度的中位数，比均值更不容易被极端场次拉高。'
};

function showMetricInfo(label, value, note = '') {
  let dialog = $('#metric-dialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'metric-dialog';
    dialog.className = 'dialog';
    document.body.append(dialog);
  }
  dialog.replaceChildren(
    h('div', { class: 'dialog-head' },
      h('div', {},
        h('p', { class: 'eyebrow' }, 'METRIC'),
        h('h2', {}, label)
      ),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': '关闭', onclick: () => dialog.close() }, '×')
    ),
    h('p', { class: 'dialog-lead' }, note || '当前筛选范围内的只读统计。'),
    h('div', { class: 'metric-detail-value' }, String(value)),
    h('p', { class: 'analysis-note' }, METRIC_EXPLAIN[label] || '只读统计，不训练模型，不构成投注建议。'),
    h('div', { class: 'dialog-actions' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => dialog.close() }, '知道了')
    )
  );
  dialog.showModal();
}

function analysisKpi(label, value, note = '') {
  return h('button', {
    class: 'analysis-kpi',
    type: 'button',
    'aria-label': `${label}：${value}，查看口径`,
    onclick: () => showMetricInfo(label, value, note)
  },
    h('span', {}, label),
    h('strong', {}, String(value)),
    note ? h('small', {}, note) : null
  );
}

function metricTable(headers, rows, cells) {
  if (!rows.length) return h('p', { class: 'analysis-note' }, '当前筛选下没有可统计的完整赔率。');
  return h('div', { class: 'analysis-table-wrap' },
    h('table', { class: 'analysis-table' },
      h('thead', {}, h('tr', {}, ...headers.map((header) => h('th', {}, header)))),
      h('tbody', {}, ...rows.map((row) => h('tr', { class: row.reliable === false ? 'metric-row-muted' : '' },
        ...cells(row).map((cell) => h('td', {}, cell))
      )))
    )
  );
}

function analysisBar(label, value, color = 'var(--accent)') {
  const width = Math.max(0, Math.min(100, Number(value) || 0));
  return h('div', { class: 'analysis-bar-row' },
    h('span', {}, label),
    h('div', { class: 'analysis-bar' },
      h('i', { style: `width:${width}%;background:${color}` })
    ),
    h('b', {}, `${Math.round(width * 10) / 10}%`)
  );
}

function signed(value) {
  const number = Number(value) || 0;
  return `${number > 0 ? '+' : ''}${number}pp`;
}

function signedPercent(value) {
  const number = Number(value) || 0;
  return `${number > 0 ? '+' : ''}${number}%`;
}

function analysisSignalLevels(levels) {
  if (!levels?.length) return h('p', { class: 'analysis-note' }, '还没有可分类的信号。');
  return h('div', { class: 'analysis-chip-row' },
    ...levels.map((row) => h('span', { class: 'analysis-chip' }, `${row.label} · ${row.count}`))
  );
}

function analysisSignalRows(rows) {
  if (!rows.length) return h('p', { class: 'analysis-note' }, '当前筛选下没有已结算信号。');
  return h('div', { class: 'analysis-signal-list' },
    ...rows.slice(0, 16).map((row) => h('div', { class: 'analysis-signal-row analysis-signal-league-row' },
      h('span', { class: 'analysis-signal-main' },
        h('b', {}, `${row.league} · ${row.marketLabel}`),
        h('small', {}, `样本 ${row.sample} · 命中 ${row.hitRate}% · 市场 ${row.avgPredicted}%`)
      ),
      h('span', { class: 'analysis-signal-result' },
        h('b', { class: row.hitGap >= 0 ? 'up' : 'down' }, signed(row.hitGap)),
        h('small', { class: row.roi >= 0 ? 'up' : 'down' }, `ROI ${signedPercent(row.roi)}`)
      )
    ))
  );
}

function analysisSignalCalibration(rows) {
  if (!rows.length) return h('p', { class: 'analysis-note' }, '还没有校准样本。');
  return h('div', { class: 'analysis-table-wrap' },
    h('table', { class: 'analysis-table' },
      h('thead', {}, h('tr', {},
        h('th', {}, '热门概率'), h('th', {}, '样本'), h('th', {}, '实际命中'),
        h('th', {}, '预测均值'), h('th', {}, '差')
      )),
      h('tbody', {}, ...rows.map((row) => h('tr', {},
        h('td', {}, row.label),
        h('td', {}, String(row.sample)),
        h('td', {}, `${row.actual}%`),
        h('td', {}, `${row.predicted}%`),
        h('td', { class: row.gap >= 0 ? 'up' : 'down' }, signed(row.gap))
      )))
    )
  );
}

function analysisSignalRecent(rows) {
  if (!rows.length) return h('p', { class: 'analysis-note' }, '还没有信号。');
  return h('div', { class: 'analysis-signal-list' },
    ...rows.map((row) => {
      const result = row.hit === true ? '命中' : row.hit === false ? '未中' : row.tie ? '平手不判' : '待结算';
      const tone = row.hit === true ? 'hit' : row.hit === false ? 'miss' : 'pending';
      return h('button', {
        class: 'analysis-signal-row',
        type: 'button',
        onclick: () => openDetail(row.matchId)
      },
        h('span', { class: 'analysis-signal-main' },
          h('b', {}, row.matchLabel),
          h('small', {}, `${row.league} · ${row.marketLabel} · 最热 ${row.favoriteLabel} ${row.probability ?? '—'}%`)
        ),
        h('span', { class: `analysis-signal-result ${tone}` },
          h('b', {}, result),
          h('small', {}, row.outcomeLabel)
        )
      );
    })
  );
}

function renderSignalStats(stats) {
  const root = $('#analysis-body');
  const perf = stats.performance;
  const enough = perf.sample >= stats.scope.minSample;

  root.append(h('div', { class: 'analysis-kpis' },
    analysisKpi('信号样本', stats.scope.samples, `${stats.scope.matches} 场比赛`),
    analysisKpi('已结算', stats.scope.settledSamples, `覆盖 ${stats.overview.coverage}%`),
    analysisKpi('最热命中率', `${perf.hitRate}%`, `市场隐含 ${perf.avgPredicted}%`),
    analysisKpi('相对市场', signed(perf.hitGap), enough ? '样本 ≥ 20' : '样本不足 20'),
    analysisKpi('ROI', signedPercent(perf.roi), `均赔 ${perf.avgOdds}`)
  ));

  if (!enough) {
    root.append(h('div', { class: 'analysis-callout warn' },
      h('div', {},
        h('strong', {}, `样本 ${perf.sample}，还不到 ${stats.scope.minSample} 个`),
        h('p', {}, '命中率和 ROI 波动会很大，先当方向参考，不要据此改策略。')
      )
    ));
  }

  const settled = stats.scope.settledSamples || 1;
  root.append(analysisPanel('热门分布', 'DISTRIBUTION',
    h('div', { class: 'analysis-bars' },
      ...stats.distribution.favorites.map((row) =>
        analysisBar(row.label, (row.count / settled) * 100, row.key === 'draw' ? 'var(--warm)' : 'var(--accent)')
      )
    ),
    h('div', { class: 'analysis-chip-row' },
      ...stats.distribution.markets.map((row) => h('span', { class: 'analysis-chip' }, `${row.label} · ${row.count}`))
    ),
    analysisSignalLevels(stats.distribution.levels)
  ));

  root.append(analysisPanel('命中与收益', 'PERFORMANCE',
    h('div', { class: 'analysis-split' },
      analysisKpi('可判样本', perf.sample, `平手/待结算 ${stats.quality.ties + stats.quality.missingResult}`),
      analysisKpi('命中', perf.hits, `命中率 ${perf.hitRate}%`),
      analysisKpi('市场均值', `${perf.avgPredicted}%`, '热门项去水概率'),
      analysisKpi('相对市场', signed(perf.hitGap), '命中率 − 市场均值'),
      analysisKpi('均注 ROI', signedPercent(perf.roi), '按最后一个赔率')
    ),
    h('div', { class: 'analysis-chip-row' },
      h('span', { class: 'analysis-chip' }, `Brier ${perf.brier}`),
      h('span', { class: 'analysis-chip' }, `LogLoss ${perf.logLoss}`),
      h('span', { class: 'analysis-chip' }, `均赔 ${perf.avgOdds}`)
    ),
    h('p', { class: 'analysis-note' }, '市场均值是热门选项的隐含概率；ROI 按最后一个盘口赔率、热门选项均注估算，不含手续费。')
  ));

  const movement = stats.movement;
  const movementBuckets = movement.buckets || {};
  const directionCard = (label, bucket, flat = false) => {
    const sample = bucket?.sample ?? 0;
    const note = !sample
      ? '暂无样本'
      : flat
        ? '无方向项，不计打出率'
        : `打出率 ${bucket.hitRate}% · 市场 ${bucket.avgPredicted}% · 相对 ${signed(bucket.hitGap)}pp`;
    return analysisKpi(label, String(sample), note);
  };
  root.append(analysisPanel('最大波动方向', 'MOVEMENT',
    h('div', { class: 'analysis-split' },
      directionCard('升温', movementBuckets.up),
      directionCard('降温', movementBuckets.down),
      directionCard('平稳', movementBuckets.flat, true)
    ),
    h('div', { class: 'analysis-chip-row' },
      h('span', { class: 'analysis-chip' }, `可判 ${movement.sample} = 升温 ${movementBuckets.up?.sample ?? 0} + 降温 ${movementBuckets.down?.sample ?? 0} + 平稳 ${movementBuckets.flat?.sample ?? 0}`),
      h('span', { class: 'analysis-chip' }, `平均最大变化 ${movement.avgAbsMove}pp`)
    ),
    analysisSignalLevels(movement.levels),
    h('p', { class: 'analysis-note' }, '按三项中波动最大的那一项分类：> +0.3pp 为升温，< -0.3pp 为降温，中间为平稳；平稳没有方向项，不计算打出率。')
  ));

  root.append(analysisPanel('联赛 × 盘口', 'LEAGUE / LINE',
    analysisSignalRows(stats.rows),
    h('p', { class: 'analysis-note' }, '按联赛和盘口拆分；样本越少波动越大，优先看 30 场以上的行。')
  ));

  root.append(analysisPanel('概率校准', 'CALIBRATION',
    analysisSignalCalibration(stats.calibration),
    h('p', { class: 'analysis-note' }, '把热门概率分桶，比较市场预测与实际命中；差值为正表示实际高于市场。')
  ));

  root.append(analysisPanel('最近信号', 'RECENT',
    analysisSignalRecent(stats.recent),
    h('p', { class: 'analysis-note' }, '点一行可打开比赛详情；只读，不修改数据。')
  ));
}

function renderAnalysisMarketFilters() {
  const wrap = $('#analysis-market-wrap');
  if (!wrap) return;
  const isSignal = state.analysisTab === 'signal';
  const isMarket = state.analysisTab === 'market';
  wrap.hidden = !isSignal && !isMarket;
  if (!isSignal && !isMarket) return;

  const options = listSignalMarkets(state.matches.filter((match) => !match.deletedAt));
  const available = new Set(options.map((option) => option.key));
  state.analysisMarkets = state.analysisMarkets.filter((key) => available.has(key));
  const selected = new Set(state.analysisMarkets);
  const filter = $('#analysis-market-filter');
  if (!filter) return;

  const handicapOptions = options.filter((option) => option.key.startsWith('handicap:'));
  const handicapKeys = handicapOptions.map((option) => option.key);
  const selectedHandicaps = state.analysisMarkets.filter((key) => key.startsWith('handicap:'));
  const selectedSpf = selected.has('spf');
  const allHandicaps = handicapKeys.length > 1
    && selectedHandicaps.length === handicapKeys.length
    && !selectedSpf;

  let handicapValue = '';
  if (allHandicaps) handicapValue = 'all';
  else if (!selectedSpf && selectedHandicaps.length === 1) handicapValue = selectedHandicaps[0];
  else if (selectedHandicaps.length > 0) handicapValue = 'all';

  const handicapSelect = h('select', {
    id: 'analysis-handicap-select',
    class: 'market-submenu-select',
    'aria-label': '让球盘筛选',
    disabled: !handicapOptions.length,
    onchange: (event) => {
      const value = event.target.value;
      if (!value) state.analysisMarkets = [];
      else if (value === 'all') state.analysisMarkets = [...handicapKeys];
      else state.analysisMarkets = [value];
      renderAnalysis();
    }
  },
    h('option', { value: '' }, handicapOptions.length ? '让球盘' : '暂无让球盘'),
    h('option', { value: 'all' }, '全部让球'),
    ...handicapOptions.map((option) => h('option', { value: option.key }, option.label))
  );
  handicapSelect.value = handicapValue;

  filter.replaceChildren(
    h('button', {
      class: `market-chip${selected.size ? '' : ' active'}`,
      type: 'button',
      onclick: () => {
        state.analysisMarkets = [];
        renderAnalysis();
      }
    }, '全部'),
    h('button', {
      class: `market-chip${selectedSpf && !selectedHandicaps.length ? ' active' : ''}`,
      type: 'button',
      onclick: () => {
        state.analysisMarkets = selectedSpf && !selectedHandicaps.length ? [] : ['spf'];
        renderAnalysis();
      }
    }, '常规盘'),
    h('label', {
      class: `market-submenu${selectedHandicaps.length ? ' active' : ''}`
    },
      h('span', { class: 'sr-only' }, '让球盘子菜单'),
      handicapSelect
    )
  );

  const strength = $('#analysis-strength');
  if (strength) strength.value = state.analysisStrength;
}

function renderAnalysisLegacy() {
  const root = $('#analysis-body');
  if (!root) return;
  const stats = buildAnalysisStats(state.matches);
  clear(root);

  if (!stats.overview.matches) {
    root.append(h('div', { class: 'empty compact' },
      h('h2', {}, '还没有可分析的数据'),
      h('p', {}, '先录入一场比赛和赔率，这里会自动生成只读统计。')
    ));
    return;
  }

  const overview = stats.overview;
  root.append(h('div', { class: 'analysis-kpis' },
    analysisKpi('比赛', overview.matches, `${overview.leagues} 个联赛`),
    analysisKpi('已结算', overview.settled, `赛果覆盖 ${overview.resultCoveragePct}%`),
    analysisKpi('时间点', overview.snapshots, `${overview.markets} 个市场`),
    analysisKpi('平均返还率', `${overview.avgReturnRatePct}%`, `抽水 ${overview.avgOverroundPct}%`),
    analysisKpi('收盘/赛前覆盖', `${overview.closingCoveragePct}%`, `${overview.withOdds} 场有赔率`)
  ));

  const quality = stats.quality;
  root.append(analysisPanel('数据质量', 'DATA QUALITY',
    h('div', { class: 'analysis-quality-grid' },
      analysisKpi('无赔率场次', quality.noOdds),
      analysisKpi('完赛缺比分', quality.finishedWithoutScore),
      analysisKpi('过时未结算', quality.pastUnsettled),
      analysisKpi('缺停售时间', quality.missingCutoff),
      analysisKpi('缺收盘/赛前', quality.missingClosing),
      analysisKpi('重复发布时间', quality.duplicates)
    ),
    h('p', { class: 'analysis-note' }, '质量只提示缺口，不改动原始数据。半场缺失会影响半全场结算。')
  ));

  root.append(analysisPanel('市场覆盖', 'COVERAGE',
    h('table', { class: 'analysis-table' },
      h('thead', {}, h('tr', {}, h('th', {}, '玩法'), h('th', {}, '有赔率'), h('th', {}, '覆盖'))),
      h('tbody', {},
        ...stats.coverage.rows.map((row) => h('tr', {},
          h('td', {}, row.label),
          h('td', {}, `${row.matches} 场`),
          h('td', {}, h('div', { class: 'analysis-mini-bar' },
            h('i', { style: `width:${row.percent}%` }),
            h('span', {}, `${row.percent}%`)
          ))
        ))
      )
    )
  ));

  const pricing = stats.pricing;
  root.append(h('div', { class: 'analysis-grid' },
    analysisPanel('定价水平', 'PRICING',
      h('div', { class: 'analysis-split' },
        analysisKpi('有效样本', pricing.sample),
        analysisKpi('平均返还率', `${pricing.avgReturnRatePct}%`),
        analysisKpi('平均抽水', `${pricing.avgOverroundPct}%`)
      ),
      h('div', { class: 'analysis-bars' },
        analysisBar('主胜', pricing.avgProbabilities.home),
        analysisBar('平局', pricing.avgProbabilities.draw, '#c08a5a'),
        analysisBar('客胜', pricing.avgProbabilities.away, '#6d7f9c')
      ),
      h('p', { class: 'analysis-note' },
        `市场热门：主胜 ${pricing.favoriteCounts.home} · 平局 ${pricing.favoriteCounts.draw} · 客胜 ${pricing.favoriteCounts.away} · 接近 ${pricing.favoriteCounts.tie}`
      )
    ),
    analysisPanel('赛果分布', 'RESULTS',
      h('div', { class: 'analysis-split' },
        analysisKpi('已结算', stats.results.sample),
        analysisKpi('场均进球', stats.results.avgGoals)
      ),
      h('div', { class: 'analysis-bars' },
        analysisBar('主胜', stats.results.outcomePercents.home),
        analysisBar('平局', stats.results.outcomePercents.draw, '#c08a5a'),
        analysisBar('客胜', stats.results.outcomePercents.away, '#6d7f9c')
      ),
      h('div', { class: 'analysis-chip-row' },
        ...stats.results.goals.filter((row) => row.count > 0).map((row) =>
          h('span', { class: 'analysis-chip' }, `${row.goals} 球 · ${row.count}`)
        )
      ),
      h('div', { class: 'analysis-chip-row' },
        ...stats.results.scores.map((row) =>
          h('span', { class: 'analysis-chip' }, `${row.score} · ${row.count}`)
        )
      )
    )
  ));

  const movement = stats.movement;
  root.append(analysisPanel('初盘 → 停售变化', 'MOVEMENT',
    h('div', { class: 'analysis-split' },
      analysisKpi('可比较样本', movement.sample),
      analysisKpi('平均绝对变化', `${movement.avgAbsMovePct}pp`),
      analysisKpi('主胜升温/降温/平稳', `${movement.up} / ${movement.down} / ${movement.flat}`)
    ),
    h('div', { class: 'analysis-chip-row' },
      h('span', { class: 'analysis-chip' }, `主胜 ${signed(movement.avg.home)}`),
      h('span', { class: 'analysis-chip' }, `平局 ${signed(movement.avg.draw)}`),
      h('span', { class: 'analysis-chip' }, `客胜 ${signed(movement.avg.away)}`)
    ),
    movement.biggest.length
      ? h('div', { class: 'analysis-list' },
          ...movement.biggest.map((item) => h('div', { class: 'analysis-list-row' },
            h('span', {}, `${item.label} · ${item.labelText}`),
            h('b', { class: item.delta >= 0 ? 'up' : 'down' }, signed(item.delta))
          ))
        )
      : h('p', { class: 'analysis-note' }, '至少需要两个时间点才能比较变化。')
  ));

  root.append(analysisPanel('联赛对比', 'LEAGUES',
    h('div', { class: 'analysis-table-wrap' },
      h('table', { class: 'analysis-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, '联赛'), h('th', {}, '场次'), h('th', {}, '已结算'),
          h('th', {}, '主胜'), h('th', {}, '平'), h('th', {}, '客胜'),
          h('th', {}, '场均进球'), h('th', {}, '返还率')
        )),
        h('tbody', {},
          ...stats.leagues.map((row) => h('tr', {},
            h('td', {}, row.league),
            h('td', {}, String(row.matches)),
            h('td', {}, String(row.settled)),
            h('td', {}, `${row.homePct}%`),
            h('td', {}, `${row.drawPct}%`),
            h('td', {}, `${row.awayPct}%`),
            h('td', {}, row.avgGoals),
            h('td', {}, `${row.avgReturnRatePct}%`)
          ))
        )
      )
    )
  ));

  root.append(h('p', { class: 'analysis-note' },
    `生成于 ${formatFullDateTime(stats.generatedAt)} · 只读统计，不训练模型，不构成投注建议。`
  ));
}

function analysisBaseMatches() {
  return state.matches.filter((match) => {
    if (match.deletedAt) return false;
    if (!matchesSeason(match, state.analysisSeason)) return false;
    if (state.analysisLeague !== 'all' && match.league !== state.analysisLeague) return false;
    if (!matchesRound(match, state.analysisRound)) return false;
    if (!withinDays(match, state.analysisRange)) return false;
    const needle = state.analysisSearch.trim().toLowerCase();
    if (!needle) return true;
    return [match.home, match.away, match.league, match.season, match.roundLabel, match.matchNum, formatCompetitionLabel(match)]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });
}

function analysisSectionTitle(tab) {
  return {
    overview: '概览',
    market: '市场',
    results: '赛果',
    quality: '质量',
    leagues: '联赛'
  }[tab] || '概览';
}

function analysisScopeText(base, visible, pending) {
  const parts = [
    state.analysisStatus === 'settled' ? `已结算样本 ${visible.length} 场` : `当前筛选 ${visible.length} 场`,
    state.analysisSeason === 'all' ? '全部赛季' : (state.analysisSeason === '__none__' ? '未标赛季' : `${state.analysisSeason} 赛季`),
    state.analysisLeague === 'all' ? '全部联赛' : state.analysisLeague,
    state.analysisRound === 'all' ? '全部轮次' : (state.analysisRound === '__none__' ? '未标轮次' : formatRoundLabel(state.analysisRound)),
    state.analysisRange === 'all' ? '全部时间' : `近 ${state.analysisRange} 天`
  ];
  if (state.analysisSearch.trim()) parts.push(`搜索“${state.analysisSearch.trim()}”`);
  if (pending) parts.push(`${pending} 场待结算未计入赛果统计`);
  return parts.join(' · ');
}

function pendingAnalysisList(matches) {
  if (!matches.length) {
    return h('p', { class: 'analysis-note' }, '没有待结算比赛。');
  }
  return h('div', { class: 'analysis-pending-list' }, matches.slice(0, 8).map((match) =>
    h('button', {
      class: 'analysis-pending-row',
      type: 'button',
      onclick: () => openDetail(match.matchId)
    },
      h('span', {},
        h('b', {}, `${match.home} vs ${match.away}`),
        h('small', {}, `${formatCompetitionLabel(match)} · ${formatKickoff(match.kickoff)}`)
      ),
      h('span', { class: 'analysis-pending-action' }, hasPending(match) ? '录赛果 ›' : '查看 ›')
    )
  ));
}

function renderAnalysis() {
  const root = $('#analysis-body');
  if (!root) return;

  const active = state.matches.filter((match) => !match.deletedAt);
  const seasonSelect = $('#analysis-season');
  if (seasonSelect) {
    seasonSelect.replaceChildren(...seasonOptions(active, state.analysisSeason));
    if (![...seasonSelect.options].some((option) => option.value === state.analysisSeason)) {
      state.analysisSeason = 'all';
      seasonSelect.value = 'all';
    }
  }

  const leagueSelect = $('#analysis-league');
  if (leagueSelect) {
    leagueSelect.replaceChildren(...leagueOptions(active, state.analysisLeague));
    leagueSelect.value = state.analysisLeague;
  }

  const roundSelect = $('#analysis-round');
  if (roundSelect) {
    roundSelect.replaceChildren(...roundOptions(active, state.analysisRound, {
      season: state.analysisSeason,
      league: state.analysisLeague
    }));
    if (![...roundSelect.options].some((option) => option.value === state.analysisRound)) {
      state.analysisRound = 'all';
    }
    roundSelect.value = state.analysisRound;
  }

  const base = analysisBaseMatches();
  const visible = state.analysisStatus === 'settled'
    ? base.filter((match) => match.status === 'finished' && match.result)
    : base;
  const pending = base.filter((match) => hasPending(match) || match.status === 'scheduled' || match.status === 'postponed').length;
  const stats = buildAnalysisStats(visible);
  const signalStats = state.analysisTab === 'signal'
    ? buildSignalStats(base, {
        league: state.analysisLeague,
        range: state.analysisRange,
        status: state.analysisStatus,
        marketKeys: state.analysisMarkets,
        strength: state.analysisStrength
      })
    : null;
  const metricStats = state.analysisTab === 'market'
    ? buildMetricStats(base, {
        league: state.analysisLeague,
        range: state.analysisRange,
        status: state.analysisStatus,
        marketKeys: state.analysisMarkets,
        strength: state.analysisStrength
      })
    : null;
  const scope = $('#analysis-scope');
  if (scope) {
    scope.textContent = state.analysisTab === 'signal'
      ? `信号 ${signalStats.scope.samples} 个 · 已结算 ${signalStats.scope.settledSamples} 个 · ${state.analysisMarkets.length ? `${state.analysisMarkets.length} 个盘口` : '全部盘口'}`
      : analysisScopeText(base, visible, pending);
  }

  renderAnalysisMarketFilters();

  document.querySelectorAll('[data-analysis-tab]').forEach((tab) => {
    const active = tab.dataset.analysisTab === state.analysisTab;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  clear(root);
  if (state.analysisTab === 'signal') {
    if (!signalStats.scope.samples) {
      root.append(h('div', { class: 'empty compact' },
        h('h2', {}, '当前筛选没有信号'),
        h('p', {}, '换一个盘口、联赛或时间范围；信号需要录入完整的胜平负/让球赔率。')
      ));
      renderMetricNav();
      return;
    }
    renderSignalStats(signalStats);
    root.append(h('p', { class: 'analysis-note' },
      `生成于 ${formatFullDateTime(signalStats.generatedAt)} · 只读信号统计，不训练模型，不构成投注建议。`
    ));
    renderMetricNav();
    return;
  }

  if (!stats.overview.matches) {
    root.append(h('div', { class: 'empty compact' },
      h('h2', {}, '当前筛选没有可分析数据'),
      h('p', {}, pending ? `有 ${pending} 场待结算；录入赛果后才会进入已结算统计。` : '换一个联赛或时间范围，或先录入比赛。')
    ));
    renderMetricNav();
    return;
  }

  const overview = stats.overview;
  if (state.analysisTab === 'overview') {
    root.append(h('div', { class: 'analysis-kpis' },
      analysisKpi('比赛', overview.matches, `${overview.leagues} 个联赛`),
      analysisKpi('已结算', overview.settled, `赛果覆盖 ${overview.resultCoveragePct}%`),
      analysisKpi('时间点', overview.snapshots, `${overview.markets} 个市场`),
      analysisKpi('平均返还率', `${overview.avgReturnRatePct}%`, `抽水 ${overview.avgOverroundPct}%`),
      analysisKpi('收盘/赛前覆盖', `${overview.closingCoveragePct}%`, `${overview.withOdds} 场有赔率`)
    ));
    if (pending) {
      root.append(h('div', { class: 'analysis-callout' },
        h('div', {},
          h('strong', {}, `另有 ${pending} 场待结算`),
          h('p', {}, '待结算不进入赛果分布；录完赛果后自动计入。')
        ),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => switchView('pending') }, '去待结算')
      ));
    }
    root.append(analysisPanel('市场覆盖', 'COVERAGE',
      h('table', { class: 'analysis-table' },
        h('thead', {}, h('tr', {}, h('th', {}, '玩法'), h('th', {}, '有赔率'), h('th', {}, '覆盖'))),
        h('tbody', {}, ...stats.coverage.rows.map((row) => h('tr', {},
          h('td', {}, row.label),
          h('td', {}, `${row.matches} 场`),
          h('td', {}, h('div', { class: 'analysis-mini-bar' },
            h('i', { style: `width:${row.percent}%` }),
            h('span', {}, `${row.percent}%`)
          ))
        )))
      )
    ));
  }

  if (state.analysisTab === 'market') {
    const pricing = stats.pricing;
    const movement = stats.movement;
    root.append(analysisPanel('定价水平', 'PRICING',
      h('div', { class: 'analysis-split' },
        analysisKpi('有效样本', pricing.sample),
        analysisKpi('平均返还率', `${pricing.avgReturnRatePct}%`),
        analysisKpi('平均抽水', `${pricing.avgOverroundPct}%`)
      ),
      h('div', { class: 'analysis-bars' },
        analysisBar('主胜', pricing.avgProbabilities.home),
        analysisBar('平局', pricing.avgProbabilities.draw, 'var(--warm)'),
        analysisBar('客胜', pricing.avgProbabilities.away, 'var(--ink-2)')
      ),
      h('p', { class: 'analysis-note' },
        `市场热门：主胜 ${pricing.favoriteCounts.home} · 平局 ${pricing.favoriteCounts.draw} · 客胜 ${pricing.favoriteCounts.away} · 接近 ${pricing.favoriteCounts.tie}`
      )
    ));
    root.append(analysisPanel('初盘 → 停售变化', 'MOVEMENT',
      h('div', { class: 'analysis-split' },
        analysisKpi('可比较样本', movement.sample),
        analysisKpi('平均绝对变化', `${movement.avgAbsMovePct}pp`),
        analysisKpi('主胜升温/降温/平稳', `${movement.up} / ${movement.down} / ${movement.flat}`)
      ),
      h('div', { class: 'analysis-chip-row' },
        h('span', { class: 'analysis-chip' }, `主胜 ${signed(movement.avg.home)}`),
        h('span', { class: 'analysis-chip' }, `平局 ${signed(movement.avg.draw)}`),
        h('span', { class: 'analysis-chip' }, `客胜 ${signed(movement.avg.away)}`)
      ),
      movement.biggest.length
        ? h('div', { class: 'analysis-list' }, ...movement.biggest.map((item) =>
          h('div', { class: 'analysis-list-row' },
            h('span', {}, `${item.label} · ${item.labelText}`),
            h('b', { class: item.delta >= 0 ? 'up' : 'down' }, signed(item.delta))
          )))
        : h('p', { class: 'analysis-note' }, '至少需要两个时间点才能比较变化。')
    ));

    if (metricStats) {
      root.append(analysisPanel('相对价格与离散', 'RELATIVE PRICE / DISPERSION',
        h('div', { class: 'analysis-split' },
          analysisKpi('相对价格均值', metricStats.kelly.avgFavorite, '热门项相对价格，基准返还率 92%'),
          analysisKpi('相对价格极差', metricStats.kelly.avgSpread, '三项相对价格最大值减最小值'),
          analysisKpi('离散均值', `${metricStats.dispersion.avg}%`, '三项去水概率的变异系数'),
          analysisKpi('离散中位', `${metricStats.dispersion.median}%`)
        ),
        h('div', { class: 'analysis-chip-row' },
          h('span', { class: 'analysis-chip' }, `相对价格≥1 · ${metricStats.kelly.overOne} 项`),
          h('span', { class: 'analysis-chip' }, `离散 P25–P75 · ${metricStats.dispersion.p25}%–${metricStats.dispersion.p75}%`),
          h('span', { class: 'analysis-chip' }, `可判样本 · ${metricStats.settledSample}`)
        ),
        h('p', { class: 'analysis-note' },
          '相对价格 = 0.92 × 赔率 / 三项平均赔率，只描述该选项相对同场均价的位置，不是下注凯利。离散是同一场三项去水概率的变异系数。样本少于 20 的分桶只灰显，不下结论。'
        )
      ));

      root.append(analysisPanel('热门概率分桶 × 赛果', 'FAVORITE PROBABILITY BUCKETS',
        metricTable(
          ['热门概率', '可判样本', '命中率', '相对市场', 'ROI'],
          metricStats.relationship.probability,
          (row) => [
            row.label,
            row.sample,
            `${row.hitRate}%`,
            signed(row.hitGap),
            `${row.roi}%`
          ]
        ),
        h('p', { class: 'analysis-note' }, '按热门项去水概率分桶；命中率是热门项打出率，ROI 按最后一个赔率均注估算。这才是“市场概率是否准”的分桶。')
      ));

      root.append(analysisPanel('离散分桶 × 赛果', 'DISPERSION BUCKETS',
        metricTable(
          ['离散区间', '可判样本', '命中率', '相对市场', 'ROI'],
          metricStats.relationship.dispersion,
          (row) => [
            row.label,
            row.sample,
            `${row.hitRate}%`,
            signed(row.hitGap),
            `${row.roi}%`
          ]
        ),
        h('p', { class: 'analysis-note' }, '离散越高代表三项越不均衡；分桶命中率只作描述，不代表可预测。')
      ));

      root.append(analysisPanel('按热门赔率', 'PRICE BUCKETS',
        metricTable(
          ['热门赔率', '样本', '平均相对价格', '平均离散', '命中率', 'ROI'],
          metricStats.byOdds,
          (row) => [
            row.label,
            row.sample,
            row.avgKelly,
            `${row.avgDispersion}%`,
            `${row.hitRate}%`,
            `${row.roi}%`
          ]
        ),
        h('p', { class: 'analysis-note' }, '同价位比较：把热门赔率落在同一区间的信号放在一起，避免只看高赔率。')
      ));

      root.append(analysisPanel('联赛指标', 'LEAGUE METRICS',
        metricTable(
          ['联赛', '样本', '平均相对价格', '平均离散', '命中率', 'ROI'],
          metricStats.byLeague,
          (row) => [
            row.league,
            row.sample,
            row.avgKelly,
            `${row.avgDispersion}%`,
            `${row.hitRate}%`,
            `${row.roi}%`
          ]
        ),
        h('p', { class: 'analysis-note' }, '联赛样本少时波动很大；优先看样本 30 场以上的行。')
      ));
    }
  }

  if (state.analysisTab === 'results') {
    root.append(analysisPanel('赛果分布', 'RESULTS',
      h('div', { class: 'analysis-split' },
        analysisKpi('已结算', stats.results.sample),
        analysisKpi('场均进球', stats.results.avgGoals)
      ),
      h('div', { class: 'analysis-bars' },
        analysisBar('主胜', stats.results.outcomePercents.home),
        analysisBar('平局', stats.results.outcomePercents.draw, 'var(--warm)'),
        analysisBar('客胜', stats.results.outcomePercents.away, 'var(--ink-2)')
      ),
      h('div', { class: 'analysis-chip-row' },
        ...stats.results.goals.filter((row) => row.count > 0).map((row) =>
          h('span', { class: 'analysis-chip' }, `${row.goals} 球 · ${row.count}`)
        )
      ),
      h('div', { class: 'analysis-chip-row' },
        ...stats.results.scores.map((row) => h('span', { class: 'analysis-chip' }, `${row.score} · ${row.count}`))
      )
    ));
    root.append(h('p', { class: 'analysis-note' }, '赛果只使用已结算比赛的 90 分钟比分；让球、总进球、比分、半全场结算在比赛详情查看。'));
  }

  if (state.analysisTab === 'quality') {
    const quality = stats.quality;
    root.append(analysisPanel('数据质量', 'DATA QUALITY',
      h('div', { class: 'analysis-quality-grid' },
        analysisKpi('无赔率场次', quality.noOdds),
        analysisKpi('完赛缺比分', quality.finishedWithoutScore),
        analysisKpi('过时未结算', quality.pastUnsettled),
        analysisKpi('缺停售时间', quality.missingCutoff),
        analysisKpi('缺收盘/赛前', quality.missingClosing),
        analysisKpi('重复发布时间', quality.duplicates)
      ),
      h('p', { class: 'analysis-note' }, '质量只提示缺口，不改动原始数据。半场缺失会影响半全场结算。')
    ));
    root.append(analysisPanel('待结算 / 待补录', 'PENDING',
      pendingAnalysisList(base.filter((match) => hasPending(match) || match.status === 'scheduled' || match.status === 'postponed'))
    ));
    root.append(analysisPanel('市场覆盖', 'COVERAGE',
      h('div', { class: 'analysis-table-wrap' },
        h('table', { class: 'analysis-table' },
          h('thead', {}, h('tr', {}, h('th', {}, '玩法'), h('th', {}, '有赔率'), h('th', {}, '覆盖'))),
          h('tbody', {}, ...stats.coverage.rows.map((row) => h('tr', {},
            h('td', {}, row.label),
            h('td', {}, `${row.matches} 场`),
            h('td', {}, `${row.percent}%`)
          )))
        )
      )
    ));
  }

  if (state.analysisTab === 'leagues') {
    root.append(analysisPanel('联赛对比', 'LEAGUES',
      h('div', { class: 'analysis-table-wrap' },
        h('table', { class: 'analysis-table' },
          h('thead', {}, h('tr', {},
            h('th', {}, '联赛'), h('th', {}, '场次'), h('th', {}, '已结算'),
            h('th', {}, '主胜'), h('th', {}, '平'), h('th', {}, '客胜'),
            h('th', {}, '场均进球'), h('th', {}, '返还率')
          )),
          h('tbody', {}, ...stats.leagues.map((row) => h('tr', {},
            h('td', {}, row.league),
            h('td', {}, String(row.matches)),
            h('td', {}, String(row.settled)),
            h('td', {}, `${row.homePct}%`),
            h('td', {}, `${row.drawPct}%`),
            h('td', {}, `${row.awayPct}%`),
            h('td', {}, row.avgGoals),
            h('td', {}, `${row.avgReturnRatePct}%`)
          )))
        )
      )
    ));
  }

  root.append(h('p', { class: 'analysis-note' },
    `生成于 ${formatFullDateTime(stats.generatedAt)} · 只读统计，不训练模型，不构成投注建议。`
  ));
  renderMetricNav();
}

function renderDataView() {
  const settled = settledMatches();
  const list = settled.filter((match) => {
    if (!matchesSeason(match, state.dataSeason)) return false;
    if (state.dataLeague !== 'all' && match.league !== state.dataLeague) return false;
    if (!matchesRound(match, state.dataRound)) return false;
    if (!withinDays(match, state.dataRange)) return false;
    const needle = state.dataSearch.trim().toLowerCase();
    if (!needle) return true;
    return [match.home, match.away, match.league, match.season, match.roundLabel, match.matchNum, formatCompetitionLabel(match)]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });

  const seasonSelect = $('#data-season');
  if (seasonSelect) {
    seasonSelect.replaceChildren(...seasonOptions(settled, state.dataSeason));
    if (![...seasonSelect.options].some((option) => option.value === state.dataSeason)) {
      state.dataSeason = 'all';
    }
    seasonSelect.value = state.dataSeason;
  }

  const leagueSelect = $('#data-league');
  if (leagueSelect) {
    leagueSelect.replaceChildren(...leagueOptions(settled, state.dataLeague));
    leagueSelect.value = state.dataLeague;
  }

  const roundSelect = $('#data-round');
  if (roundSelect) {
    roundSelect.replaceChildren(...roundOptions(settled, state.dataRound, {
      season: state.dataSeason,
      league: state.dataLeague
    }));
    if (![...roundSelect.options].some((option) => option.value === state.dataRound)) {
      state.dataRound = 'all';
    }
    roundSelect.value = state.dataRound;
  }
  const count = $('#data-count');
  if (count) count.textContent = `${list.length} 场已录入赛果`;
  const listNode = $('#data-list');
  clear(listNode);
  list.forEach((match) => listNode.append(matchCard(match, { collapsible: true })));
  const empty = $('#data-empty');
  if (empty) empty.hidden = list.length > 0;
}

function render() {
  const stats = countStats(state.matches);
  $('#stat-matches').textContent = String(stats.matches);
  const pending = pendingMatches();
  $('#stat-pending').textContent = String(pending.length);
  $('#stat-snapshots').textContent = String(stats.snapshots);
  $('#stat-markets').textContent = String(stats.markets);
  const navCount = $('#nav-pending-count');
  if (navCount) {
    navCount.textContent = String(pending.length);
    navCount.hidden = pending.length === 0;
  }

  const list = filteredMatches();
  const listNode = $('#match-list');
  clear(listNode);
  list.forEach((match) => listNode.append(matchCard(match)));
  $('#empty-state').hidden = list.length > 0;

  const pendingNode = $('#pending-list');
  clear(pendingNode);
  pending.forEach((match) => pendingNode.append(matchCard(match, { pendingView: true })));
  $('#pending-empty').hidden = pending.length > 0;

  const last = state.lastExportAt ? `上次导出：${formatFullDateTime(state.lastExportAt)}` : '还没有导出过';
  const lastExport = $('#last-export');
  if (lastExport) lastExport.textContent = last;
  renderDashboard(stats);
  renderAnalysis();
  renderDataView();
  renderCapabilities();
  renderMarketStrip();
}

async function refresh() {
  try {
    state.matches = await listMatches();
    state.lastExportAt = await getSetting('lastExportAt', null);
    render();
  } catch (error) {
    console.error(error);
    toast(`读取本地数据失败：${error.message}`, 'error');
  }
}

function syncTopbarHeight() {
  const topbar = $('.topbar');
  if (!topbar) return;
  document.documentElement.style.setProperty('--topbar-height', `${Math.ceil(topbar.getBoundingClientRect().height)}px`);
}

function saveScrollPosition() {
  if (state.view === 'analysis') {
    analysisScrollMemory.set(state.analysisTab, window.scrollY);
  } else {
    viewScrollMemory.set(state.view, window.scrollY);
  }
}

function targetScrollPosition() {
  const value = state.view === 'analysis'
    ? analysisScrollMemory.get(state.analysisTab)
    : viewScrollMemory.get(state.view);
  return Number.isFinite(value) ? value : 0;
}

function restoreScrollPosition() {
  const target = targetScrollPosition();
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: target, behavior: 'instant' });
      updateMetricActive();
      updateBackToTop();
    });
  });
}

function scrollToTop() {
  if (state.view === 'analysis') analysisScrollMemory.set(state.analysisTab, 0);
  else viewScrollMemory.set(state.view, 0);
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function decorateAnalysisAnchors() {
  const root = $('#analysis-body');
  if (!root) return;
  root.querySelectorAll('.analysis-panel').forEach((panel) => {
    const title = panel.querySelector('h3')?.textContent.trim();
    const id = ANALYSIS_ANCHOR_IDS[title];
    if (!id) return;
    panel.id = id;
    panel.classList.add('analysis-anchor');
  });
  if (state.analysisTab === 'signal') {
    const kpis = root.querySelector('.analysis-kpis');
    if (kpis) {
      kpis.id = 'metric-signal-overview';
      kpis.classList.add('analysis-anchor');
    }
  }
}

function renderMetricNav() {
  const nav = $('#analysis-metric-nav');
  if (!nav) return;
  decorateAnalysisAnchors();
  const entries = METRIC_NAV[state.analysisTab] || [];
  const available = entries.filter(([id]) => document.getElementById(id));
  const previousMetric = lastActiveMetric;
  lastActiveMetric = available.some(([id]) => id === previousMetric) ? previousMetric : '';
  if (!available.length) {
    nav.hidden = true;
    nav.replaceChildren();
    return;
  }
  nav.hidden = false;
  nav.replaceChildren(...available.map(([id, label]) =>
    h('button', {
      type: 'button',
      class: 'metric-nav-item',
      'data-metric': id,
      onclick: () => scrollToMetric(id)
    }, label)
  ));
  updateMetricActive();
  if (lastActiveMetric) {
    requestAnimationFrame(() => scrollToMetric(lastActiveMetric, { smooth: false }));
  }
}

function scrollToMetric(id, { smooth = true } = {}) {
  const target = document.getElementById(id);
  const nav = $('#analysis-metric-nav');
  if (!target) return;
  lastActiveMetric = id;
  const topbarHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-height')) || 68;
  const navHeight = nav && !nav.hidden ? nav.offsetHeight : 0;
  const top = Math.max(0, target.getBoundingClientRect().top + window.scrollY - topbarHeight - navHeight - 24);
  window.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
}

function updateMetricActive() {
  const nav = $('#analysis-metric-nav');
  if (!nav || nav.hidden) return;
  const buttons = [...nav.querySelectorAll('[data-metric]')];
  if (!buttons.length) return;
  const topbarHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-height')) || 68;
  const threshold = topbarHeight + nav.offsetHeight + 24;
  let active = buttons[0];
  for (const button of buttons) {
    const target = document.getElementById(button.dataset.metric);
    if (target && target.getBoundingClientRect().top <= threshold) active = button;
  }
  if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
    active = buttons[buttons.length - 1];
  }
  const changed = active.dataset.metric !== lastActiveMetric;
  lastActiveMetric = active.dataset.metric;
  buttons.forEach((button) => {
    const isActive = button === active;
    button.classList.toggle('active', isActive);
    if (isActive) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  });
  if (!changed) return;
  const left = active.offsetLeft - nav.clientWidth / 2 + active.offsetWidth / 2;
  if (nav.scrollWidth > nav.clientWidth) nav.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
}

function updateBackToTop() {
  const button = $('#back-to-top');
  if (!button) return;
  const subpageOpen = Boolean(document.querySelector('.subpage:not([hidden])'));
  const dialogOpen = Boolean(document.querySelector('dialog[open]'));
  button.hidden = subpageOpen || dialogOpen || window.scrollY < 520;
}

function switchView(view) {
  const changed = view !== state.view;
  if (changed) saveScrollPosition();
  state.view = view;
  document.querySelectorAll('.bottom-nav-item[data-view]').forEach((item) => {
    const active = item.dataset.view === view;
    item.classList.toggle('active', active);
    item.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  for (const section of ['matches', 'pending', 'analysis', 'data', 'capabilities']) {
    const node = $(`#view-${section}`);
    if (node) node.hidden = section !== view;
  }
  const home = view === 'matches';
  const hero = $('.dashboard > .hero');
  const statGrid = $('.dashboard > .stat-grid');
  if (hero) hero.hidden = !home;
  if (statGrid) statGrid.hidden = !home;
  const homeCards = ['health-card', 'trend-card', 'quick-card'];
  for (const cardClass of homeCards) {
    const card = document.querySelector(`.dashboard > .${cardClass}`);
    if (card) card.hidden = !home;
  }
  if (view === 'analysis') renderAnalysis();
  if (view === 'data') renderDataView();
  renderMarketStrip();
  if (changed) restoreScrollPosition();
  updateBackToTop();
}

function openNewMatch() {
  closeDialog($('#detail-dialog'));
  const form = $('#new-match-form');
  form.reset();
  clearDateTimeFields('new-kickoff');
  clearDateTimeFields('new-sales');
  showSubpage('page-new-match');
  window.setTimeout(() => form.elements.home.focus(), 60);
}

function newMatchDirty() {
  const form = $('#new-match-form');
  return ['home', 'away', 'league', 'season', 'roundLabel', 'matchNum', 'note']
    .some((name) => form.elements[name].value.trim() !== '');
}

function closeNewMatch(force = false) {
  if (!force && newMatchDirty() && !window.confirm('放弃本次新增比赛？')) return;
  hideSubpage('page-new-match');
}

function isoToLocalInput(iso, withSeconds = false) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString();
  return withSeconds ? local.slice(0, 19) : local.slice(0, 16);
}

function refreshEditSnapshotCount() {
  const count = [...document.querySelectorAll('#edit-markets .edit-snapshot')].length;
  const node = $('#edit-snapshot-count');
  if (node) node.textContent = `${count} 个时间点`;
}

function editSnapshotRow(market, snapshot) {
  const row = h('div', { class: 'edit-snapshot', dataset: { snapshotId: snapshot.snapshotId } });
  const when = h('label', { class: 'edit-time' },
    h('span', {}, snapshot.isClosing ? '发布时间 · 收盘' : '发布时间'),
    h('input', {
      class: 'edit-time-input',
      type: 'datetime-local',
      step: '1',
      value: isoToLocalInput(snapshot.publishedAt, true)
    })
  );

  const remove = h('button', {
    class: 'edit-delete',
    type: 'button',
    onclick: () => {
      const card = row.closest('.edit-market');
      const rows = card ? [...card.querySelectorAll('.edit-snapshot')] : [];
      if (rows.length <= 1) {
        if (!window.confirm(`这是 ${formatMarketLabel(market.type, market.line)} 的最后一个时间点，删除后会删除整个玩法。继续？`)) return;
        card?.remove();
      } else {
        if (!window.confirm('删除这个时间点？')) return;
        row.remove();
      }
      editState.dirty = true;
      refreshEditSnapshotCount();
    }
  }, '删除');

  const oddsGrid = h('div', { class: 'edit-odds-grid' },
    sortedSelectionKeys(market, snapshot).map((key) => h('label', { class: 'edit-odd' },
      h('span', {}, formatSelection(market.type, key, market.line)),
      h('input', {
        type: 'number',
        step: '0.01',
        min: '1.01',
        inputmode: 'decimal',
        'data-key': key,
        value: Number(snapshot.odds[key]) > 1 ? formatOdds(snapshot.odds[key]) : ''
      })
    ))
  );

  row.append(h('div', { class: 'edit-snapshot-head' }, when, remove), oddsGrid);
  return row;
}

function editMarketCard(market) {
  const title = h('h3', {}, formatMarketLabel(market.type, market.line));
  const removeMarket = h('button', {
    class: 'btn ghost small danger-text',
    type: 'button',
    'aria-label': `删除整个${formatMarketLabel(market.type, market.line)}玩法`
  }, '删除玩法');
  removeMarket.addEventListener('click', () => {
    if (!window.confirm(`删除整个“${formatMarketLabel(market.type, market.line)}”玩法？保存修改后生效。`)) return;
    const wasNew = editState.newMarkets.some((item) => item.marketId === market.marketId);
    editState.newMarkets = editState.newMarkets.filter((item) => item.marketId !== market.marketId);
    if (!wasNew) editState.removedMarketIds.push(market.marketId);
    editState.dirty = true;
    removeMarket.closest('.edit-market')?.remove();
    refreshEditSnapshotCount();
  });
  const card = h('section', {
    class: 'edit-market',
    dataset: { marketId: market.marketId }
  },
    h('div', { class: 'edit-market-head' }, title, removeMarket),
    h('p', {}, `${market.snapshots?.length || 0} 个时间点 · 修改后会自动重算信号与结算`)
  );
  if (market.type === 'handicap') {
    const lineInput = h('input', {
      class: 'edit-line-input',
      type: 'text',
      inputmode: 'numeric',
      value: String(market.line),
      placeholder: '例如 +1 / -1',
      'aria-label': '让球数'
    });
    lineInput.addEventListener('input', () => {
      editState.dirty = true;
      const number = Number(lineInput.value);
      if (Number.isFinite(number)) {
        title.textContent = formatMarketLabel('handicap', number);
      }
    });
    card.append(h('label', { class: 'edit-line-field' },
      h('span', {}, '让球数'),
      lineInput,
      h('small', {}, '正数受让，负数让球')
    ));
  }
  const snapshots = [...(market.snapshots || [])].sort((a, b) => (
    (Date.parse(a.publishedAt) || 0) - (Date.parse(b.publishedAt) || 0)
  ));
  snapshots.forEach((snapshot) => card.append(editSnapshotRow(market, snapshot)));
  return card;
}

function renderEditMarkets(match) {
  const box = $('#edit-markets');
  if (!box) return;
  clear(box);
  const markets = sortMarkets([...(match.markets || []), ...editState.newMarkets]);
  if (!markets.length) {
    box.append(h('div', { class: 'empty compact' }, h('p', {}, '还没有赔率时间点。先保存比赛信息，再在详情里追加赔率。')));
    refreshEditSnapshotCount();
    return;
  }
  for (const market of markets) box.append(editMarketCard(market));
  refreshEditSnapshotCount();
}

function collectEditedMarkets() {
  const markets = [];
  for (const card of document.querySelectorAll('#edit-markets .edit-market')) {
    const source = [...(editState.match?.markets || []), ...editState.newMarkets]
      .find((market) => market.marketId === card.dataset.marketId);
    if (!source) continue;
    let line = source.line;
    if (source.type === 'handicap') {
      const lineInput = card.querySelector('.edit-line-input');
      const rawLine = lineInput?.value.trim() || '';
      const number = Number(rawLine);
      if (!rawLine || !Number.isFinite(number) || !Number.isInteger(number)) {
        throw new Error('让球数必须是整数，例如 +2 或 -1');
      }
      line = number;
    }
    const snapshots = [];
    for (const row of card.querySelectorAll('.edit-snapshot')) {
      const before = source.snapshots?.find((snapshot) => snapshot.snapshotId === row.dataset.snapshotId);
      if (!before) continue;
      const timeInput = row.querySelector('.edit-time-input');
      const publishedAt = timeInput?.value ? new Date(timeInput.value).toISOString() : null;
      const odds = {};
      for (const input of row.querySelectorAll('.edit-odds-grid input[data-key]')) {
        const number = Number(input.value);
        if (!Number.isFinite(number) || number <= 1) {
          throw new Error(`${formatSelection(source.type, input.dataset.key, line)} 的赔率必须大于 1`);
        }
        odds[input.dataset.key] = Math.round((number + Number.EPSILON) * 100) / 100;
      }
      snapshots.push({ ...before, publishedAt, odds });
    }
    if (snapshots.length) markets.push({ ...source, line, snapshots });
  }
  return markets;
}

async function openEditMatch(matchId) {
  try {
    const match = await getMatch(matchId);
    if (!match || match.deletedAt) {
      toast('这场比赛不存在或已删除', 'error');
      return;
    }
    editState.match = match;
    editState.newMarkets = [];
    editState.removedMarketIds = [];
    editState.dirty = false;
    const addPanel = $('#edit-add-panel');
    if (addPanel) addPanel.hidden = true;
    closeDialog($('#detail-dialog'));
    const form = $('#edit-match-form');
    form.reset();
    for (const name of ['home', 'away', 'league', 'season', 'roundLabel', 'matchNum', 'note']) {
      form.elements[name].value = match[name] || '';
    }
    setDateTimeFields('edit-kickoff', match.kickoff);
    setDateTimeFields('edit-sales', match.salesCutoffAt);
    form.elements.editReason.value = '';
    const reasonWrap = $('#edit-reason-wrap');
    if (reasonWrap) reasonWrap.hidden = !match.result;
    const badge = $('#edit-badge');
    if (badge) badge.textContent = match.result ? '已结算' : (STATUS_LABELS[match.status] || '待赛');
    renderEditMarkets(match);
    showSubpage('page-edit-match');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function closeEditMatch(force = false) {
  if (!force && editState.dirty && !window.confirm('放弃本次修改？')) return;
  hideSubpage('page-edit-match');
  editState.match = null;
  editState.newMarkets = [];
  editState.removedMarketIds = [];
  editState.dirty = false;
}

function addNewMarket() {
  const match = editState.match;
  if (!match) return;
  const type = $('#edit-add-type')?.value || 'spf';
  let line = null;
  if (type === 'handicap') {
    const rawLine = $('#edit-add-line')?.value.trim() || '';
    const number = Number(rawLine);
    if (!rawLine || !Number.isInteger(number)) {
      toast('让球数必须是整数，例如 +1 或 -1', 'error');
      return;
    }
    line = number;
  }
  const sameMarket = [...(match.markets || []), ...editState.newMarkets]
    .filter((market) => !editState.removedMarketIds.includes(market.marketId))
    .some((market) => (
      market.type === type && (type !== 'handicap' || Number(market.line) === line)
    ));
  if (sameMarket) {
    toast(`已经有${formatMarketLabel(type, line)}，不能重复添加`, 'error');
    return;
  }
  const market = createMarket(type, { line });
  const kickoff = Date.parse(match.kickoff) || Date.now();
  const publishedAt = new Date(Math.min(Date.now(), kickoff - 60 * 60 * 1000)).toISOString();
  const snapshot = createSnapshot({ publishedAt, odds: {}, rawText: '手动新增玩法' });
  snapshot.odds = Object.fromEntries(selectionOrder(market).map((key) => [key, '']));
  market.snapshots = [snapshot];
  editState.newMarkets.push(market);
  editState.dirty = true;
  $('#edit-markets')?.append(editMarketCard(market));
  refreshEditSnapshotCount();
  const panel = $('#edit-add-panel');
  if (panel) panel.hidden = true;
  $('.edit-market[data-market-id="' + market.marketId + '"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  toast('已添加空玩法，请填写赔率时间点', 'info');
}

async function saveEditedMatch(event) {
  event.preventDefault();
  const match = editState.match;
  if (!match) return;
  const form = event.currentTarget;
  const data = new FormData(form);
  try {
    const kickoff = readDateTimeFields('edit-kickoff', { required: true, label: '开赛时间' });
    const salesCutoffAt = readDateTimeFields('edit-sales', { label: '停售时间' });
    const rawFields = {
      home: data.get('home'),
      away: data.get('away'),
      league: data.get('league'),
      season: data.get('season'),
      roundLabel: data.get('roundLabel'),
      kickoff,
      salesCutoffAt,
      matchNum: data.get('matchNum'),
      note: data.get('note')
    };
    const fields = validateEditFields(rawFields);
    const markets = collectEditedMarkets();
    validateEditedMarkets(markets, { kickoff: fields.kickoff });
    const updated = applyMatchEdit(match, {
      fields: { ...rawFields, ...fields },
      markets,
      reason: data.get('editReason')
    });
    await putMatch(updated);
    closeEditMatch(true);
    toast('修改已保存，信号与结算已刷新');
    await refresh();
    openDetail(updated.matchId);
  } catch (error) {
    toast(error.message, 'error');
  }
}

function auditSection(match) {
  const entries = [...(match.audit || [])]
    .filter((entry) => entry.action !== 'create')
    .slice(-5)
    .reverse();
  if (!entries.length) return null;
  return h('section', { class: 'audit-block' },
    h('h3', {}, '修改记录'),
    entries.map((entry) => h('div', { class: 'audit-row' },
      h('time', {}, formatFullDateTime(entry.at)),
      h('span', {}, entry.detail || entry.action)
    ))
  );
}

function openDetail(matchId) {
  getMatch(matchId).then((match) => {
    if (!match || match.deletedAt) {
      toast('这场比赛不存在或已删除', 'error');
      refresh();
      return;
    }
    state.activeMatch = match;
    renderDetail(match);
    const detail = $('#detail-dialog');
    if (!detail.open) detail.showModal();
  }).catch((error) => toast(error.message, 'error'));
}

function detailHeader(match) {
  const wasEdited = (match.audit || []).some((entry) => entry.action === 'edit_match' || entry.action === 'edit_result');
  return h('div', { class: 'detail-head' },
    h('div', {},
      h('p', { class: 'eyebrow' },
        `${formatCompetitionLabel(match)} · ${STATUS_LABELS[match.status] || match.status}`,
        wasEdited ? h('span', { class: 'modified-pill' }, '已修改') : null
      ),
      h('h2', {}, `${match.home} vs ${match.away}`),
      h('div', { class: 'detail-sub' },
        h('span', {}, formatKickoff(match.kickoff)),
        match.matchNum ? h('span', {}, match.matchNum) : null,
        h('span', {}, `${match.markets?.length || 0} 个市场`)
      )
    ),
    h('div', { class: 'detail-actions' },
      h('button', {
        class: 'btn',
        type: 'button',
        onclick: () => openEditMatch(match.matchId)
      }, '编辑'),
      h('button', {
        class: 'btn',
        type: 'button',
        onclick: () => openMarketDialog(match, { returnToDetail: true })
      }, '＋ 追加赔率'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => openSettleDialog(match) },
        match.status === 'finished' ? '修改赛果' : '录入赛果'),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': '关闭', onclick: () => closeDialog($('#detail-dialog')) }, '×')
    )
  );
}

function resultStrip(match) {
  if (match.result && match.status === 'finished') {
    return h('div', { class: 'result-strip' },
      h('div', {},
        h('strong', {}, `${match.result.homeGoals}:${match.result.awayGoals}`),
        h('span', { class: 'result-note' }, match.result.htHome !== null && match.result.htHome !== undefined
          ? `  半场 ${match.result.htHome}:${match.result.htAway}  ·  90 分钟`
          : '  90 分钟')
      ),
      h('div', { class: 'result-note' },
        match.result.note || '已结算',
        h('br'),
        `结算于 ${formatFullDateTime(match.result.settledAt)}`
      )
    );
  }
  if (match.status !== 'scheduled') {
    return h('div', { class: 'result-strip' },
      h('strong', {}, STATUS_LABELS[match.status] || match.status),
      h('span', { class: 'result-note' }, '无效比赛，不计入训练集')
    );
  }
  return h('div', { class: 'result-strip' },
    h('span', { class: 'result-note' }, '还没有录赛果。比赛结束后在这里补 90 分钟比分。'),
    statusBadge(match.status)
  );
}

function marketBlock(match, market) {
  const latest = latestSnapshot(market);
  const keys = sortedSelectionKeys(market, latest);
  const settledLabel = market.winningSelection
    ? formatSelection(market.type, market.winningSelection, market.line)
    : (market.settlementStatus === 'void' ? '无效' : market.settlementStatus === 'pending' ? '待结算' : '—');

  const head = h('div', { class: 'market-head' },
    h('div', {},
      h('h3', {}, formatMarketLabel(market.type, market.line)),
      h('small', {}, `${market.snapshots?.length || 0} 个时间点 · ${MARKET_LABELS[market.type] || market.type}`)
    ),
    h('span', { class: 'market-result' }, settledLabel)
  );

  let body;
  if (!latest) {
    body = h('div', { class: 'odds-grid' }, h('span', { class: 'muted' }, '这个市场还没有时间点'));
  } else if (market.type === 'score') {
    body = h('div', { class: 'odds-grid' }, keys.map((key) => h(
      'span',
      { class: `odds-pill ${market.winningSelection === key ? 'win' : ''}` },
      h('span', {}, formatSelection(market.type, key, market.line)),
      h('b', {}, formatOdds(latest.odds[key]))
    )));
  } else {
    const snapshots = [...(market.snapshots || [])]
      .sort((a, b) => (Date.parse(a.publishedAt) || 0) - (Date.parse(b.publishedAt) || 0))
      .slice(-6);
    const table = h('table', { class: 'snapshot-table' },
      h('thead', {}, h('tr', {},
        h('th', {}, '时间'),
        keys.map((key) => h('th', {}, formatSelection(market.type, key, market.line)))
      )),
      h('tbody', {}, snapshots.map((snapshot) => h('tr', {},
        h('td', {}, snapshot.publishedAt ? formatKickoff(snapshot.publishedAt) : '未标时间'),
        keys.map((key) => h('td', {}, formatOdds(snapshot.odds[key])))
      )))
    );
    body = h('div', { class: 'snapshot-scroll' }, table);
  }

  const actions = h('div', { class: 'market-actions' },
    h('span', { class: 'muted' }, latest?.publishedAt ? `最新 ${formatFullDateTime(latest.publishedAt)}` : '无时间点'),
    h('button', {
      class: 'link-btn',
      type: 'button',
      onclick: () => openMarketDialog(match, { type: market.type, line: market.line, returnToDetail: true })
    }, '追加时间点')
  );

  return h('section', { class: 'market-block' }, head, body, actions);
}

function signalCard(signal) {
  if (!signal) return null;

  const outcomes = ['home', 'draw', 'away'];
  const isHandicap = signal.marketType === 'handicap';
  const bars = outcomes.map((key) => h('div', { class: 'signal-bar-row' },
    h('span', {}, isHandicap ? `让${key === 'home' ? '胜' : key === 'draw' ? '平' : '负'}` : (key === 'home' ? '主胜' : key === 'draw' ? '平局' : '客胜')),
    h('div', { class: 'signal-bar-track' },
      h('i', {
        class: `signal-bar-fill signal-${key}`,
        style: `width:${signal.probabilities[key]}%`
      })
    ),
    h('b', {}, `${signal.probabilities[key]}%`)
  ));

  const moves = outcomes.map((key) => {
    const delta = signal.movement[key];
    return h('span', { class: `signal-delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'}` },
      `${isHandicap ? (key === 'home' ? '让胜' : key === 'draw' ? '让平' : '让负') : (key === 'home' ? '主' : key === 'draw' ? '平' : '客')} ${delta >= 0 ? '+' : ''}${delta}pp`
    );
  });

  return h('section', { class: 'signal-card' },
    h('div', { class: 'signal-head' },
      h('span', { class: 'signal-kicker' }, isHandicap ? 'HANDICAP SIGNAL · 实验' : 'MARKET SIGNAL · 实验'),
      h('span', { class: 'signal-level' }, signal.level)
    ),
    h('div', { class: 'signal-title' },
      h('div', {},
        h('div', { class: 'signal-market-row' },
          h('p', { class: 'signal-market' }, `${signal.marketLabel} · 市场倾向`),
          signal.lineLabel ? h('span', { class: 'signal-line-label' }, signal.lineLabel) : null
        ),
        h('h3', {}, signal.favorite.label, h('strong', {}, ` ${signal.probabilities[signal.favorite.key]}%`))
      ),
      h('span', { class: 'signal-favorite' }, `${signal.favorite.label}最热`)
    ),
    h('div', { class: 'signal-bars' }, bars),
    h('div', { class: 'signal-meta' },
      h('span', {}, `返还率 ${signal.returnRatePct}%`),
      h('span', {}, `抽水 ${signal.overroundPct}%`),
      h('span', {}, `${signal.sample} 个时间点`)
    ),
    h('div', { class: 'signal-move-head' },
      h('span', {}, signal.single ? '暂无可比变化' : `变化 · ${signal.movementLevel}`),
      h('span', { class: 'muted' }, signal.latestAt ? `最新 ${formatFullDateTime(signal.latestAt)}` : '最新时间未标')
    ),
    signal.single ? null : h('div', { class: 'signal-moves' }, moves),
    h('p', { class: 'signal-note' }, signal.note),
    h('p', { class: 'signal-disclaimer' }, signal.disclaimer)
  );
}

function impliedBlock(data) {
  if (!data || data.missing) return null;

  const labels = { totals: '总进球 / 大小球', score: '比分 / 波胆' };
  const title = labels[data.market] || data.market;
  if (data.incomplete) {
    return h('div', { class: 'implied-block' },
      h('div', { class: 'implied-block-head' },
        h('h4', {}, title),
        h('span', { class: 'implied-status warn' }, '数据不完整')
      ),
      h('p', { class: 'implied-empty' },
        `只录了 ${data.recorded}/${data.expected} 项，暂不计算概率。把缺的赔率补齐后再看。`)
    );
  }

  const meta = h('div', { class: 'implied-block-head' },
    h('h4', {}, title),
    h('span', { class: 'implied-status' }, `返还率 ${data.returnRatePct}%`)
  );

  if (data.market === 'totals') {
    const chips = h('div', { class: 'implied-chips' }, data.options.map((option) => h(
      'span',
      { class: 'implied-chip' },
      h('span', {}, option.label),
      h('b', {}, `${option.probabilityPct}%`)
    )));
    const ou = h('div', { class: 'implied-ou' }, data.overUnder.map((row) => h(
      'div',
      { class: 'implied-ou-row' },
      h('span', {}, `大小 ${row.line}`),
      h('b', {}, `大 ${row.overPct}%`),
      h('b', {}, `小 ${row.underPct}%`)
    )));
    return h('div', { class: 'implied-block' }, meta, chips, ou,
      h('p', { class: 'implied-foot' }, `${data.sample} 个时间点 · 抽水 ${data.overroundPct}%`));
  }

  const chips = h('div', { class: 'implied-chips' }, data.top.map((option) => h(
    'span',
    { class: 'implied-chip' },
    h('span', {}, option.label),
    h('b', {}, `${option.probabilityPct}%`)
  )));
  const groups = h('div', { class: 'implied-groups' },
    h('span', {}, `主胜 ${data.groups.home}%`),
    h('span', {}, `平局 ${data.groups.draw}%`),
    h('span', {}, `客胜 ${data.groups.away}%`)
  );
  return h('div', { class: 'implied-block' }, meta, chips, groups,
    h('p', { class: 'implied-foot' }, `Top 8 · ${data.sample} 个时间点 · 抽水 ${data.overroundPct}%`));
}

function impliedCard(match) {
  const data = buildImpliedMarkets(match);
  if (!data) return null;
  const blocks = [impliedBlock(data.totals), impliedBlock(data.score)].filter(Boolean);
  if (!blocks.length) return null;
  return h('section', { class: 'implied-card' },
    h('div', { class: 'implied-head' },
      h('div', {},
        h('p', { class: 'eyebrow' }, 'IMPLIED PROBABILITY'),
        h('h3', {}, '市场隐含概率')
      ),
      h('span', { class: 'implied-badge' }, '赔率换算 · 非推荐')
    ),
    h('p', { class: 'implied-lead' }, '把录入的赔率去掉抽水后换算成概率，只解释市场定价。'),
    h('div', { class: 'implied-grid' }, blocks),
    h('p', { class: 'implied-note' }, '只对录入完整的玩法计算；缺项或停售后录入的赔率会被跳过。')
  );
}

function tendencyBlock(row) {
  return h('div', { class: 'tendency-block' },
    h('div', { class: 'tendency-head' },
      h('b', {}, '倾向 vs 市场'),
      h('span', {}, '实际 - 市场，正=市场低估')
    ),
    h('div', { class: 'tendency-table' },
      ...row.tendency.map((item) => h('div', { class: 'tendency-row' },
        h('span', { class: 'tendency-label' }, item.label),
        h('span', {}, `${item.market.toFixed(1)}%`),
        h('span', {}, item.actual === null ? '—' : `${item.actual}%`),
        h('span', {
          class: `tendency-diff${item.difference === null ? '' : item.difference > 0 ? ' positive' : item.difference < 0 ? ' negative' : ''}`
        }, item.difference === null ? '—' : `${item.difference > 0 ? '+' : ''}${item.difference.toFixed(1)}pp`)
      ))
    )
  );
}

function matchMetricCard(match) {
  const rows = buildMatchMetricRows(match);
  if (!rows.length) return null;
  return h('section', { class: 'match-metric-card' },
    h('div', { class: 'match-metric-head' },
      h('div', {},
        h('p', { class: 'eyebrow' }, 'MATCH METRICS'),
        h('h3', {}, '本场相对价格 / 离散')
      ),
      h('span', { class: 'match-metric-badge' }, '92% 基准')
    ),
    h('p', { class: 'match-metric-lead' }, '只按本场录入的赔率计算，不引用统计页的其他比赛。'),
    ...rows.map((row) => h('div', { class: 'match-metric-row' },
      h('div', { class: 'match-metric-row-head' },
        h('b', {}, row.marketLabel),
        h('span', {}, `离散 ${Number(row.dispersion).toFixed(2)}% · 极差 ${Number(row.kellySpread).toFixed(2)}`)
      ),
      h('div', { class: 'match-metric-odds' },
        ...['home', 'draw', 'away'].map((key) => h('div', {
          class: `match-metric-odd${row.favoriteKey === key ? ' favorite' : ''}`
        },
          h('span', {}, row.labels[key]),
          h('strong', {}, Number(row.kelly[key]).toFixed(2))
        ))
      ),
      h('div', { class: 'match-metric-tags' },
        h('span', { class: 'match-metric-tag' }, `离散区间 ${row.dispersionBucket}`),
        h('span', { class: 'match-metric-tag' }, `热门 ${row.favoriteLabel || '—'} 相对价格 ${Number(row.favoriteKelly).toFixed(2)}`)
      ),
      tendencyBlock(row)
    )),
    h('p', { class: 'match-metric-note' }, '相对价格 = 0.92 × 赔率 / 三项平均赔率，不是下注凯利；离散 = 三项去水概率的变异系数。只解释本场定价。')
  );
}

async function setClvEntry(match, market, snapshotId) {
  const snapshot = (market.snapshots || []).find((item) => item.snapshotId === snapshotId);
  market.entrySnapshotId = snapshot ? snapshot.snapshotId : null;
  const detail = snapshot
    ? `${formatMarketLabel(market.type, market.line)}：${formatFullDateTime(snapshot.publishedAt)}`
    : `${formatMarketLabel(market.type, market.line)}：清除入场`;
  const updated = addAudit(match, snapshot ? '设置 CLV 入场' : '清除 CLV 入场', detail);
  const saved = await putMatch(updated);
  await refresh();
  renderDetail(saved);
  toast(snapshot ? '已设为入场时间' : '已清除入场时间');
}

function clvCard(match) {
  const rows = buildMatchClvRows(match);
  if (!rows.length) return null;
  return h('section', { class: 'match-metric-card clv-card' },
    h('div', { class: 'match-metric-head' },
      h('div', {},
        h('p', { class: 'eyebrow' }, 'CLV · PERSONAL'),
        h('h3', {}, '入场价 vs 收盘价')
      ),
      h('span', { class: 'match-metric-badge' }, '92% 基准')
    ),
    h('p', { class: 'match-metric-lead' }, 'CLV = 入场赔率 / 收盘赔率 - 1。正数表示你买得比收盘价便宜；先选一个时间点作为入场。'),
    ...rows.map((row) => {
      const select = h('select', { class: 'clv-select', 'aria-label': `${row.label} 入场时间` },
        h('option', { value: '' }, '选择入场时间'),
        ...row.snapshots.map((snapshot) => h('option', { value: snapshot.snapshotId }, snapshot.label))
      );
      select.value = row.entry?.snapshotId || '';
      select.onchange = () => setClvEntry(match, row.market, select.value);

      let content;
      if (!row.entry) {
        content = h('p', { class: 'clv-hint' }, '还没有设置入场时间；选一个时间点后才会计算。');
      } else if (row.entryAfterClosing) {
        content = h('p', { class: 'clv-hint error' }, '入场时间晚于收盘时间，CLV 没有意义，请重新选择。');
      } else {
        content = h('div', { class: 'clv-values' }, ...row.values.map((value) => {
          const positive = Number(value.clvPct) >= 0;
          return h('div', { class: `clv-value ${positive ? 'positive' : 'negative'}` },
            h('span', {}, value.label),
            h('strong', {}, value.clvPct === null ? '—' : `${positive ? '+' : ''}${Number(value.clvPct).toFixed(1)}%`),
            h('small', {}, value.entryOdds === null ? '—' : `${value.entryOdds.toFixed(2)} → ${value.closingOdds.toFixed(2)}`)
          );
        }));
      }

      return h('div', { class: 'clv-row' },
        h('div', { class: 'clv-row-head' },
          h('b', {}, row.label),
          h('span', {}, `收盘 ${row.closing.label}${row.closingProxy ? ' · 代理' : ''}`)
        ),
        select,
        content
      );
    }),
    h('p', { class: 'match-metric-note' }, '收盘优先用收盘标记；没有标记时用停售/开赛前最后一个时间点作为代理。CLV 是价格评价，不是预测。')
  );
}

function renderDetail(match) {
  const content = $('#detail-content');
  clear(content);
  content.append(detailHeader(match), resultStrip(match));
  for (const signal of buildMarketSignals(match)) content.append(signalCard(signal));
  const metrics = matchMetricCard(match);
  if (metrics) content.append(metrics);
  const clv = clvCard(match);
  if (clv) content.append(clv);
  const implied = impliedCard(match);
  if (implied) content.append(implied);

  if (!match.markets?.length) {
    content.append(h('div', { class: 'empty compact' },
      h('h2', {}, '还没有赔率'),
      h('p', {}, '把竞彩页面上的文本粘进来，先识别、再保存。'),
      h('button', {
        class: 'btn primary',
        type: 'button',
        onclick: () => openMarketDialog(match, { returnToDetail: true })
      }, '添加第一组赔率')
    ));
  } else {
    sortMarkets(match.markets).forEach((market) => content.append(marketBlock(match, market)));
  }

  const audit = auditSection(match);
  if (audit) content.append(audit);

  const footer = h('div', { class: 'dialog-actions' },
    h('button', {
      class: 'btn danger',
      type: 'button',
      onclick: async () => {
        if (!window.confirm(`删除 ${match.home} vs ${match.away}？\n\n会从列表和导出中移除，但保留在数据库里，可恢复。`)) return;
        await softDeleteMatch(match.matchId);
        closeDialog($('#detail-dialog'));
        toast('已删除');
        refresh();
      }
    }, '删除比赛'),
    h('button', { class: 'btn ghost', type: 'button', onclick: () => closeDialog($('#detail-dialog')) }, '关闭')
  );
  content.append(footer);
  content.append(h('p', { class: 'hint' }, '数据只保存在本机浏览器。换设备或清缓存前，先到“数据”里导出 JSON。'));
}

function openSettleDialog(match) {
  const form = $('#settle-form');
  form.reset();
  form.elements.matchId.value = match.matchId;
  form.elements.status.value = match.status === 'scheduled' ? 'finished' : match.status;
  if (match.result) {
    form.elements.fullScore.value = `${match.result.homeGoals}-${match.result.awayGoals}`;
    form.elements.halfScore.value = match.result.htHome !== null && match.result.htHome !== undefined
      ? `${match.result.htHome}-${match.result.htAway}`
      : '';
    form.elements.note.value = match.result.note || '';
  }
  $('#settle-lead').textContent = `${match.home} vs ${match.away} · ${formatKickoff(match.kickoff)}`;
  updateSettleRequirements();
  updateSettlePreview();
  $('#settle-dialog').showModal();
}

function updateSettleRequirements() {
  const form = $('#settle-form');
  const finished = form.elements.status.value === 'finished';
  for (const name of ['fullScore', 'halfScore']) {
    const input = form.elements[name];
    input.disabled = !finished;
  }
  form.elements.fullScore.required = finished;
}

async function saveNewMatch(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  try {
    const kickoff = readDateTimeFields('new-kickoff', { required: true, label: '开赛时间' });
    const salesCutoffAt = readDateTimeFields('new-sales', { label: '停售时间' });
    const match = createMatch({
      home: data.get('home'),
      away: data.get('away'),
      league: data.get('league'),
      season: data.get('season'),
      roundLabel: data.get('roundLabel'),
      kickoff,
      salesCutoffAt,
      matchNum: data.get('matchNum'),
      note: data.get('note')
    });
    await putMatch(match);
    closeNewMatch(true);
    toast('比赛已创建，接着录入赔率');
    await refresh();
    openOddsEntry(match);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function saveSettlement(event) {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') {
    closeDialog($('#settle-dialog'));
    return;
  }
  const form = event.currentTarget;
  const data = new FormData(form);
  const matchId = data.get('matchId');
  const match = await getMatch(matchId);
  if (!match) {
    toast('比赛不存在', 'error');
    return;
  }
  try {
    const status = data.get('status');
    const full = status === 'finished' ? scorePair(data.get('fullScore')) : null;
    if (status === 'finished' && !full) throw new Error('请填写全场比分，例如 2-1');
    let half = status === 'finished' ? scorePair(data.get('halfScore')) : null;
    if (half && (!full || half.home > full.home || half.away > full.away)) {
      throw new Error('半场比分不能大于全场比分');
    }
    const updated = settleMatch(match, {
      homeGoals: full ? full.home : null,
      awayGoals: full ? full.away : null,
      htHome: half ? half.home : null,
      htAway: half ? half.away : null,
      status,
      note: data.get('note')
    });
    await putMatch(updated);
    state.activeMatch = updated;
    closeDialog($('#settle-dialog'));
    toast('赛果已保存，市场已结算');
    await refresh();
    if ($('#detail-dialog').open) {
      renderDetail(updated);
    }
  } catch (error) {
    toast(error.message, 'error');
  }
}

function sampleText(type) {
  const now = new Date();
  const t1 = localStamp(new Date(now.getTime() - 26 * 60 * 60 * 1000));
  const t2 = localStamp(new Date(now.getTime() - 8 * 60 * 60 * 1000));
  const t3 = localStamp(new Date(now.getTime() - 60 * 60 * 1000));
  if (type === 'spf') {
    return `${t1}（发布时间）\n胜 2.20 平 3.62 负 2.62\n\n${t2}（发布时间）\n胜 2.14 平 3.70 负 2.70\n\n${t3}（发布时间）\n胜 2.08 平 3.78 负 2.80`;
  }
  if (type === 'handicap') {
    return `${t1}（发布时间）\n+2 胜 2.13 平 4.20 负 2.37\n\n${t2}（发布时间）\n+2 胜 2.05 平 4.20 负 2.48\n\n${t3}（发布时间）\n+2 胜 2.00 平 4.26 负 2.54`;
  }
  if (type === 'totals') {
    return `${t1}（发布时间）\n0 28.00 1 8.40 2 4.80 3 3.70\n4 4.15 5 6.05 6 9.25 7+ 10.00\n\n${t3}（发布时间）\n0 24.00 1 7.80 2 4.60 3 3.70\n4 4.30 5 6.50 6 9.50 7+ 9.50`;
  }
  if (type === 'halfFull') {
    return `${t1}（发布时间）\n胜胜 14.50 胜平 20.00 胜负 19.00\n平胜 19.00 平平 9.75 平负 4.25\n负胜 56.00 负平 20.00 负负 1.60\n\n${t3}（发布时间）\n胜胜 15.00 胜平 21.00 胜负 21.00\n平胜 21.00 平平 10.00 平负 4.25\n负胜 60.00 负平 21.00 负负 1.55`;
  }
  return `${t1}（发布时间）\n1:0 29.00 2:0 60.00 2:1 24.00 3:0 200.00 3:1 70.00\n3:2 50.00 4:0 550.00 4:1 200.00 4:2 200.00 5:0 1000.00\n5:1 700.00 5:2 600.00 胜其他 200.00\n0:0 28.00 1:1 10.50 2:2 16.00 3:3 50.00 平其他 300.00\n0:1 10.00 0:2 7.00 1:2 7.25 0:3 8.50 1:3 8.50\n2:3 18.00 0:4 13.00 1:4 14.00 2:4 28.00 0:5 24.00\n1:5 26.00 2:5 50.00 负其他 12.00\n\n${t3}（发布时间）\n1:0 31.00 2:0 60.00 2:1 28.00 3:0 200.00 3:1 70.00\n3:2 50.00 4:0 550.00 4:1 200.00 4:2 200.00 5:0 1000.00\n5:1 700.00 5:2 600.00 胜其他 200.00\n0:0 24.00 1:1 10.00 2:2 17.50 3:3 60.00 平其他 300.00\n0:1 9.50 0:2 6.75 1:2 7.25 0:3 8.00 1:3 8.50\n2:3 20.00 0:4 13.00 1:4 14.00 2:4 28.00 0:5 24.00\n1:5 28.00 2:5 50.00 负其他 12.50`;
}

function renderPreview(container, parsed) {
  clear(container);
  if (!parsed.sections.length) {
    container.append(h('div', { class: 'warning-list' }, h('ul', {}, parsed.warnings.map((warning) => h('li', {}, warning)))));
    return;
  }
  for (const section of parsed.sections) {
    const box = h('div', { class: 'preview-section' },
      h('div', { class: 'preview-head' },
        h('span', {}, `${formatMarketLabel(section.type, section.line)} · ${section.snapshots.length} 个时间点`),
        h('span', { class: 'muted' }, section.line !== null ? `让球 ${section.line > 0 ? '+' : ''}${section.line}` : MARKET_SHORT[section.type] || section.type)
      ),
      h('div', { class: 'preview-list' },
        section.snapshots.slice(-4).map((snapshot) => h('div', { class: 'preview-row' },
          h('span', {}, snapshot.publishedAt ? formatFullDateTime(snapshot.publishedAt) : '未识别时间'),
          h('span', {}, `${Object.keys(snapshot.odds).length} 个选项`)
        ))
      )
    );
    container.append(box);
  }
  if (parsed.warnings.length) {
    container.append(h('div', { class: 'warning-list' },
      h('ul', {}, parsed.warnings.map((warning) => h('li', {}, warning)))
    ));
  }
}

function openMarketDialog(match, options = {}) {
  openOddsEntry(match, options);
}

function buildEntryCard(config, index) {
  const card = {
    type: config.type,
    label: config.label,
    parsed: null,
    node: null,
    body: null,
    head: null,
    textarea: null,
    lineInput: null,
    status: null,
    preview: null,
    message: null
  };

  const status = h('span', { class: 'entry-card-status' }, '未录入');
  const message = h('div', { class: 'entry-message', 'aria-live': 'polite' });
  const preview = h('div', { class: 'entry-preview' });

  const lineInput = config.line
    ? h('input', {
      type: 'number',
      step: '0.25',
      inputmode: 'decimal',
      placeholder: '例如 +2 或 -1',
      'aria-label': '让球数'
    })
    : null;

  const textarea = h('textarea', {
    class: 'entry-textarea',
    rows: '6',
    spellcheck: 'false',
    placeholder: placeholderFor(config.type),
    'aria-label': `${config.label}赔率文本`
  });

  const resetCard = () => {
    entryState.dirty = true;
    card.parsed = null;
    status.textContent = '待识别';
    status.classList.remove('ready');
    message.textContent = '';
    clear(preview);
    updateEntrySummary();
  };

  textarea.addEventListener('input', resetCard);
  lineInput?.addEventListener('input', resetCard);

  const sampleButton = h('button', {
    class: 'link-btn',
    type: 'button',
    onclick: () => {
      textarea.value = sampleText(config.type);
      resetCard();
      textarea.focus();
    }
  }, '填入示例');

  const ocrButton = h('button', {
    class: 'btn',
    type: 'button',
    hidden: !window.Capacitor?.isNativePlatform?.(),
    onclick: () => recognizeImageForCard(card)
  }, '相册识别');

  const parseButton = h('button', {
    class: 'btn',
    type: 'button',
    onclick: () => {
      if (parseEntryCard(card)) setEntryCardOpen(card.type, true);
    }
  }, '识别本卡');

  const body = h('div', { class: 'entry-card-body', hidden: true });
  if (lineInput) {
    body.append(h('label', { class: 'entry-line' },
      h('span', {}, '让球数'),
      lineInput,
      h('span', {}, '正数受让，负数让球')
    ));
  }
  body.append(
    textarea,
    h('div', { class: 'entry-tools' }, sampleButton, ocrButton, parseButton),
    preview,
    message
  );

  const head = h('button', {
    class: 'entry-card-head',
    type: 'button',
    'aria-expanded': 'false'
  },
  h('span', { class: 'entry-card-index' }, String(index + 1).padStart(2, '0')),
  h('span', { class: 'entry-card-name' }, config.label),
  status,
  h('span', { class: 'entry-caret' }, '⌄')
  );

  head.addEventListener('click', () => {
    const isOpen = card.node.classList.contains('open');
    setEntryCardOpen(isOpen ? null : card.type, !isOpen);
  });

  card.node = h('article', { class: 'entry-card', dataset: { type: config.type } }, head, body);
  card.body = body;
  card.head = head;
  card.textarea = textarea;
  card.lineInput = lineInput;
  card.status = status;
  card.preview = preview;
  card.message = message;
  card.hint = config.hint;
  return card;
}

function setEntryCardOpen(type, open = true) {
  for (const card of entryState.cards.values()) {
    const next = Boolean(open) && card.type === type;
    card.node.classList.toggle('open', next);
    card.body.hidden = !next;
    card.head.setAttribute('aria-expanded', String(next));
  }
}

function entryError(card, text) {
  card.parsed = null;
  card.status.textContent = '有错误';
  card.status.classList.remove('ready');
  card.message.textContent = text;
  clear(card.preview);
  updateEntrySummary();
}

function renderEntryPreview(card, section) {
  clear(card.preview);
  const snapshots = section.snapshots || [];
  const latest = snapshots[snapshots.length - 1];
  const optionCount = latest ? Object.keys(latest.odds || {}).length : 0;
  card.preview.append(h('div', { class: 'entry-preview-head' },
    h('span', {}, `${snapshots.length} 个时间点`),
    h('span', { class: 'muted' }, `${optionCount} 个选项${optionCount > 4 ? ' · 左右滑动看全' : ''}`)
  ));

  const list = h('div', { class: 'entry-snapshots' });
  for (const snapshot of snapshots) {
    const grid = h('div', { class: 'entry-odds-scroll' });
    for (const [selection, value] of Object.entries(snapshot.odds || {})) {
      grid.append(h('span', { class: 'entry-odd' },
        h('small', {}, formatSelection(section.type, selection, section.line)),
        h('b', {}, formatOdds(value))
      ));
    }
    list.append(h('div', { class: 'entry-snapshot' },
      h('div', { class: 'entry-snapshot-head' },
        h('span', {}, snapshot.publishedAt ? formatKickoff(snapshot.publishedAt) : '未识别时间'),
        h('span', {}, `${Object.keys(snapshot.odds || {}).length} 项`)
      ),
      grid
    ));
  }
  card.preview.append(list);

  if (section.warnings?.length) {
    card.preview.append(h('div', { class: 'entry-message' }, section.warnings.join('；')));
  }
}

async function recognizeImageForCard(card) {
  const plugin = window.Capacitor?.Plugins?.Ocr;
  if (!plugin) {
    entryError(card, '当前环境没有相册识别插件，请改用粘贴文本。');
    return;
  }
  try {
    toast('正在识别图片…');
    const result = await plugin.pickAndRecognize();
    const text = (result?.text || '').trim();
    if (!text) {
      entryError(card, '没有识别到文字，请换一张更清晰的截图。');
      return;
    }
    card.textarea.value = text;
    card.textarea.dispatchEvent(new Event('input', { bubbles: true }));
    card.textarea.focus();
    card.message.textContent = '图片文字已填入，请核对后点“识别本卡”。';
  } catch (error) {
    const message = String(error?.message || error || '识别失败');
    if (message.includes('取消')) {
      card.message.textContent = '已取消相册选择。';
      return;
    }
    entryError(card, `图片识别失败：${message}`);
  }
}

function parseEntryCard(card) {
  const text = card.textarea.value.trim();
  if (!text) {
    entryError(card, '请先粘贴这一项的赔率文本。');
    return false;
  }

  const rawLine = card.lineInput?.value.trim() || '';
  const lineHint = rawLine === '' ? null : Number(rawLine);
  if (rawLine !== '' && !Number.isFinite(lineHint)) {
    entryError(card, '让球数不是有效数字，例如 +2 或 -1。');
    return false;
  }

  let parsed;
  try {
    parsed = parsePaste(text, { lineHint, marketType: card.type });
  } catch (error) {
    entryError(card, `解析失败：${error.message}`);
    return false;
  }

  let section = parsed.sections.find((item) => item.type === card.type);
  if (!section) {
    const other = parsed.sections[0];
    entryError(card, other
      ? `这段文本被识别为「${MARKET_LABELS[other.type] || other.type}」，请确认粘贴内容和卡片是否对应。`
      : (parsed.warnings[0] || '没有识别出赔率，请检查文本格式。'));
    return false;
  }

  if (card.type === 'handicap') {
    const line = Number.isFinite(lineHint) ? lineHint : section.line;
    if (!Number.isFinite(line)) {
      entryError(card, '让球胜平负需要让球数，例如 +2 或 -1。');
      return false;
    }
    section = { ...section, line };
    if (!card.lineInput.value.trim()) card.lineInput.value = String(line);
  }

  card.parsed = section;
  card.status.textContent = `${section.snapshots.length} 个时间点`;
  card.status.classList.add('ready');
  card.message.textContent = '';
  renderEntryPreview(card, section);
  entryState.dirty = true;
  updateEntrySummary();
  return true;
}

function updateEntrySummary() {
  const cards = [...entryState.cards.values()];
  const parsedCards = cards.filter((card) => card.parsed);
  const snapshotCount = parsedCards.reduce((sum, card) => sum + card.parsed.snapshots.length, 0);
  const hasContent = cards.some((card) => card.textarea.value.trim() !== '');

  const summary = $('#odds-summary');
  if (summary) {
    summary.textContent = parsedCards.length
      ? `已识别 ${parsedCards.length}/5 个市场 · ${snapshotCount} 个时间点`
      : (hasContent ? '有内容待识别' : '还没有识别');
  }
  const badge = $('#odds-count-badge');
  if (badge) badge.textContent = `${parsedCards.length} / 5`;
  const saveButton = $('#odds-save');
  if (saveButton) saveButton.disabled = !hasContent;
}

function openOddsEntry(match, { type = null, line = null, returnToDetail = false } = {}) {
  closeDialog($('#detail-dialog'));
  entryState.match = match;
  entryState.dirty = false;
  entryState.returnToDetail = returnToDetail;
  entryState.cards.clear();

  $('#odds-title').textContent = match.markets?.length ? '追加赔率' : '录入赔率';
  $('#odds-lead').textContent = `${match.home} vs ${match.away} · 先识别，再保存`;

  const strip = $('#odds-match-strip');
  clear(strip);
  const meta = [formatCompetitionLabel(match), match.matchNum, formatKickoff(match.kickoff)]
    .filter(Boolean)
    .join(' · ');
  strip.append(
    h('div', {},
      h('h2', {}, `${match.home} vs ${match.away}`),
      h('p', {}, meta)
    ),
    h('span', { class: 'page-badge' }, `${match.markets?.length || 0} 个市场`)
  );

  const container = $('#odds-cards');
  clear(container);
  if (match.markets?.length) {
    const editSaved = h('button', { class: 'entry-edit-link', type: 'button' }, '已保存的赔率录错了？去编辑');
    editSaved.addEventListener('click', () => {
      if (entryState.dirty && !window.confirm('放弃本次未保存的赔率输入，去编辑已保存赔率？')) return;
      const matchId = entryState.match?.matchId;
      if (!matchId) return;
      entryState.dirty = false;
      hideSubpage('page-odds');
      openEditMatch(matchId);
    });
    container.append(editSaved);
  }
  ENTRY_CARDS.forEach((config, index) => {
    const card = buildEntryCard(config, index);
    entryState.cards.set(config.type, card);
    container.append(card.node);
  });

  if (type && entryState.cards.has(type)) {
    setEntryCardOpen(type, true);
    const card = entryState.cards.get(type);
    if (card.lineInput && line !== null && line !== undefined && Number.isFinite(Number(line))) {
      card.lineInput.value = String(line);
    }
  }

  updateEntrySummary();
  showSubpage('page-odds');
}

function closeOddsEntry() {
  if (!entryState.match) return;
  if (entryState.dirty && !window.confirm('放弃本次未保存的赔率输入？')) return;
  const matchId = entryState.match.matchId;
  const returnToDetail = entryState.returnToDetail;
  entryState.dirty = false;
  hideSubpage('page-odds');
  if (returnToDetail && matchId) openDetail(matchId);
}

async function saveOddsEntry() {
  const cards = [...entryState.cards.values()];
  const sections = [];

  for (const card of cards) {
    if (!card.textarea.value.trim()) continue;
    if (!card.parsed && !parseEntryCard(card)) {
      setEntryCardOpen(card.type, true);
      card.node.scrollIntoView({ block: 'center' });
      toast('有一张卡片没有识别成功，请检查红色提示', 'error');
      return;
    }
    if (card.parsed) sections.push(card.parsed);
  }

  if (!sections.length) {
    toast('还没有可保存的赔率', 'error');
    return;
  }

  try {
    let target = await getMatch(entryState.match.matchId);
    if (!target) throw new Error('比赛不存在');
    target.markets ||= [];
    let added = 0;

    for (const section of sections) {
      const sectionLine = section.type === 'handicap' ? Number(section.line) : null;
      if (section.type === 'handicap' && !Number.isFinite(sectionLine)) {
        toast('让球胜平负缺少让球数', 'error');
        return;
      }
      const existing = target.markets.find((market) => (
        market.type === section.type
        && (section.type !== 'handicap' || Number(market.line) === Number(sectionLine))
      ));
      if (existing) {
        existing.snapshots = mergeSnapshots(existing.snapshots, section.snapshots);
      } else {
        target.markets.push(createMarket(section.type, {
          line: sectionLine,
          snapshots: section.snapshots
        }));
      }
      added += section.snapshots.length;
    }

    if (target.status === 'finished' && target.result) {
      target.markets = target.markets.map((market) => ({
        ...market,
        ...settleMarket(market, target.result)
      }));
    }

    target = addAudit(target, 'add_market', `录入 ${sections.length} 个市场 / ${added} 个时间点`);
    await putMatch(target);
    state.activeMatch = target;
    entryState.dirty = false;
    const returnToDetail = entryState.returnToDetail;
    hideSubpage('page-odds');
    toast(`已保存 ${added} 个时间点`);
    await refresh();
    if (returnToDetail) openDetail(target.matchId);
    else switchView('pending');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function placeholderFor(type) {
  if (type === 'handicap') return '例如：\n2026-10-20 18:19:29（发布时间）\n+2 胜 2.13 平 4.20 负 2.37';
  if (type === 'totals') return '例如：\n2026-10-20 13:28:07（发布时间）\n0 24.00 1 7.80 2 4.60 3 3.70\n4 4.30 5 6.50 6 9.50 7+ 9.50';
  if (type === 'score') return '例如：\n2026-10-20 13:28:21（发布时间）\n1:0 31.00 2:0 60.00 2:1 28.00\n...\n胜其他 200.00 平其他 300.00 负其他 12.50';
  if (type === 'halfFull') return '例如：\n2026-10-20 10:30:34（发布时间）\n胜胜 15.00 胜平 21.00 胜负 21.00\n平胜 21.00 平平 10.00 平负 4.25\n负胜 60.00 负平 21.00 负负 1.55';
  return '例如：\n2026-10-20 18:19:35（发布时间）\n胜 2.20 平 3.62 负 2.62';
}

function downloadBlob(content, filename, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function saveTextFile(content, filename, type) {
  if (window.Capacitor?.isNativePlatform?.()) {
    const plugin = window.Capacitor?.Plugins?.FileSaver;
    if (!plugin) throw new Error('当前安装包没有文件保存插件');
    await plugin.saveText({
      filename,
      content: String(content),
      mime: type.split(';')[0]
    });
    return;
  }
  downloadBlob(content, filename, type);
}

async function exportJson() {
  try {
    const payload = await exportSnapshot();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    await saveTextFile(JSON.stringify(payload, null, 2), `jingcai-lab-${stamp}.json`, 'application/json');
    await setLastExportAt();
    state.lastExportAt = nowIso();
    render();
    toast(`已导出 ${payload.counts.matches} 场`);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function exportCsv() {
  try {
    const csv = toCsv(state.matches);
    await saveTextFile(csv, csvFileName(), 'text/csv;charset=utf-8');
    await setLastExportAt();
    state.lastExportAt = nowIso();
    render();
    toast('CSV 已导出');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function handleImportFile(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const trimmed = text.trimStart();
    const isCsv = /\.csv$/i.test(file.name) || (!trimmed.startsWith('{') && !trimmed.startsWith('['));
    let payload = isCsv ? csvToSnapshot(text) : JSON.parse(text);
    let kind = isCsv ? 'CSV 明细' : 'JSON 备份';
    let legacyWarnings = [];

    // 旧版竞彩分析器导出的是 { records: [...] }，不是当前备份格式。
    if (!isCsv && (Array.isArray(payload) || (Array.isArray(payload?.records) && !Array.isArray(payload?.matches)))) {
      const converted = legacyToMatches(payload);
      payload = { matches: converted.matches };
      kind = '旧版分析器 JSON';
      legacyWarnings = [
        '旧版没有精确发布时间，时间点按开赛前近似生成。',
        ...converted.warnings
      ];
    }

    const count = Array.isArray(payload.matches) ? payload.matches.length : 0;
    if (!count) throw new Error('文件里没有可导入的比赛数据');
    const warningText = legacyWarnings.length
      ? `\n\n有 ${legacyWarnings.length} 条提示：\n${legacyWarnings.slice(0, 3).join('\n')}`
      : '';
    if (!window.confirm(`导入 ${count} 场比赛（${kind}）？\n\n默认合并：同 ID 取较新赛果，同玩法合并时间点。${warningText}`)) return;
    const result = await importSnapshot(payload, { mode: 'merge' });
    await refresh();
    const detail = result.errors.length ? `，${result.errors.length} 条失败` : '';
    toast(`导入完成：新增 ${result.imported}，合并 ${result.merged}，跳过 ${result.skipped}${detail}`);
  } catch (error) {
    toast(`导入失败：${error.message}`, 'error');
  }
}

async function clearAllData() {
  if (!window.confirm('确定清空本机全部数据？\n\n请先导出 JSON 备份。此操作不能撤销。')) return;
  if (!window.confirm('再确认一次：删除所有比赛、赔率和赛果？')) return;
  await clearMatches();
  state.activeMatch = null;
  await refresh();
  toast('本机数据已清空');
}

function bind() {
  $('#back-to-top')?.addEventListener('click', scrollToTop);
  window.addEventListener('resize', syncTopbarHeight);
  syncTopbarHeight();
  $('#btn-new')?.addEventListener('click', openNewMatch);
  $('#empty-new').addEventListener('click', openNewMatch);
  $('#hero-new')?.addEventListener('click', openNewMatch);
  $('#quick-new')?.addEventListener('click', openNewMatch);
  $('#hero-data')?.addEventListener('click', () => switchView('data'));
  $('#quick-data')?.addEventListener('click', () => switchView('data'));
  $('#quick-export')?.addEventListener('click', exportJson);
  $('#btn-data')?.addEventListener('click', () => switchView('data'));
  $('#nav-entry')?.addEventListener('click', openNewMatch);
  document.querySelectorAll('.bottom-nav-item[data-view]').forEach((item) => {
    item.addEventListener('click', () => switchView(item.dataset.view));
  });
  document.querySelectorAll('.stat[data-stat]').forEach((stat) => {
    stat.addEventListener('click', () => handleStatClick(stat.dataset.stat));
  });
  $('#new-match-back')?.addEventListener('click', () => closeNewMatch());
  $('#new-match-cancel')?.addEventListener('click', () => closeNewMatch());
  $('#edit-back')?.addEventListener('click', () => closeEditMatch());
  $('#edit-cancel')?.addEventListener('click', () => closeEditMatch());
  $('#edit-add-market')?.addEventListener('click', () => {
    const panel = $('#edit-add-panel');
    if (panel) panel.hidden = !panel.hidden;
  });
  $('#edit-add-type')?.addEventListener('change', (event) => {
    const wrap = $('#edit-add-line-wrap');
    if (wrap) wrap.hidden = event.target.value !== 'handicap';
  });
  $('#edit-add-confirm')?.addEventListener('click', addNewMarket);
  $('#edit-add-cancel')?.addEventListener('click', () => {
    const panel = $('#edit-add-panel');
    if (panel) panel.hidden = true;
  });
  $('#edit-match-form')?.addEventListener('submit', saveEditedMatch);
  $('#edit-match-form')?.addEventListener('input', () => { editState.dirty = true; });
  $('#odds-back')?.addEventListener('click', closeOddsEntry);
  $('#odds-save')?.addEventListener('click', saveOddsEntry);
  $('#data-season')?.addEventListener('change', (event) => {
    state.dataSeason = event.target.value;
    state.dataRound = 'all';
    renderDataView();
  });
  $('#data-league')?.addEventListener('change', (event) => {
    state.dataLeague = event.target.value;
    renderDataView();
  });
  $('#data-round')?.addEventListener('change', (event) => {
    state.dataRound = event.target.value;
    renderDataView();
  });
  $('#data-range')?.addEventListener('change', (event) => {
    state.dataRange = event.target.value;
    renderDataView();
  });
  $('#data-search')?.addEventListener('input', (event) => {
    state.dataSearch = event.target.value;
    renderDataView();
  });
  document.querySelectorAll('[data-analysis-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      const next = tab.dataset.analysisTab;
      if (next === state.analysisTab) return;
      saveScrollPosition();
      state.analysisTab = next;
      renderAnalysis();
      restoreScrollPosition();
    });
  });
  $('#analysis-season')?.addEventListener('change', (event) => {
    state.analysisSeason = event.target.value;
    state.analysisRound = 'all';
    renderAnalysis();
  });
  $('#analysis-league')?.addEventListener('change', (event) => {
    state.analysisLeague = event.target.value;
    state.analysisRound = 'all';
    renderAnalysis();
  });
  $('#analysis-round')?.addEventListener('change', (event) => {
    state.analysisRound = event.target.value;
    renderAnalysis();
  });
  $('#analysis-search')?.addEventListener('input', (event) => {
    state.analysisSearch = event.target.value;
    renderAnalysis();
  });
  $('#analysis-range')?.addEventListener('change', (event) => {
    state.analysisRange = event.target.value;
    renderAnalysis();
  });
  $('#analysis-status')?.addEventListener('change', (event) => {
    state.analysisStatus = event.target.value;
    renderAnalysis();
  });
  $('#analysis-strength')?.addEventListener('change', (event) => {
    state.analysisStrength = event.target.value;
    renderAnalysis();
  });
  $('#analysis-reset')?.addEventListener('click', () => {
    state.analysisSeason = 'all';
    state.analysisLeague = 'all';
    state.analysisRound = 'all';
    state.analysisRange = 'all';
    state.analysisStatus = 'settled';
    state.analysisMarkets = [];
    state.analysisStrength = 'all';
    state.analysisSearch = '';
    $('#analysis-season').value = 'all';
    $('#analysis-league').value = 'all';
    $('#analysis-round').value = 'all';
    $('#analysis-range').value = 'all';
    $('#analysis-status').value = 'settled';
    $('#analysis-strength').value = 'all';
    $('#analysis-search').value = '';
    renderAnalysis();
  });
  $('#search-input').addEventListener('input', (event) => {
    state.search = event.target.value;
    render();
  });
  $('#status-filter').addEventListener('change', (event) => {
    state.status = event.target.value;
    render();
  });
  bindDateTimeInputs();
  $('#new-match-form').addEventListener('submit', saveNewMatch);
  $('#settle-form').addEventListener('submit', saveSettlement);
  $('#settle-form').elements.status.addEventListener('change', () => {
    updateSettleRequirements();
    updateSettlePreview();
  });
  for (const id of ['settle-full-score', 'settle-half-score']) {
    $('#' + id).addEventListener('input', updateSettlePreview);
  }
  $('#export-json').addEventListener('click', exportJson);
  $('#export-csv').addEventListener('click', exportCsv);
  $('#import-json').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', handleImportFile);
  $('#clear-data').addEventListener('click', clearAllData);
}

function registerServiceWorker() {
  if (window.Capacitor?.isNativePlatform?.()) return;
  if (!('serviceWorker' in navigator)) return;
  if (!/^https?:$/.test(location.protocol)) return;
  navigator.serviceWorker.register('./sw.js').catch((error) => {
    console.warn('Service Worker 注册失败', error);
  });
}

function applyVersion() {
  const label = `v${APP_VERSION}`;
  for (const id of ['app-version', 'data-version', 'footer-version']) {
    const node = document.getElementById(id);
    if (node) node.textContent = label;
  }
}

async function init() {
  applyVersion();
  bind();
  clearDateTimeFields('new-kickoff');
  clearDateTimeFields('new-sales');
  await refresh();
  switchView('pending');
  registerServiceWorker();
}

init().catch((error) => {
  console.error(error);
  toast(`应用初始化失败：${error.message}`, 'error');
});
