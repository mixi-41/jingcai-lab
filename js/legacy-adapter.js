import {
  createMarket,
  createMatch,
  createSnapshot,
  formatCompetitionLabel,
  nowIso
} from './schema.js';

const TIME_HEADER = /^(初始(?:指数)?|初盘|初指|变化\s*\d+|临场(?:指数)?|即时(?:指数)?|终盘)\s*$/;
const TIME_LABELS = new Map([
  ['初始', 'initial'],
  ['初盘', 'initial'],
  ['初指', 'initial'],
  ['即时', 'closing'],
  ['临场', 'closing'],
  ['终盘', 'closing']
]);

const SPECIAL_SCORE = {
  胜其他: 'other_home',
  平其他: 'other_draw',
  负其他: 'other_away'
};

const HALF_FULL = {
  胜胜: 'home_home',
  胜平: 'home_draw',
  胜负: 'home_away',
  平胜: 'draw_home',
  平平: 'draw_draw',
  平负: 'draw_away',
  负胜: 'away_home',
  负平: 'away_draw',
  负负: 'away_away'
};

function cleanText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim();
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function splitTeams(raw) {
  const text = cleanText(raw).replace(/\s+/g, ' ');
  const parts = text.split(/\s*(?:VS|Vs|vs|vS)\s*/);
  if (parts.length >= 2) {
    return { home: parts[0].trim(), away: parts.slice(1).join('VS').trim() };
  }
  // 旧数据里偶尔把比分写进球队名，例如“麦克阿瑟2-1珀斯光荣”。
  const scored = text.match(/^(.+?)\s*(\d+)\s*[-:]\s*(\d+)\s*(.+)$/);
  if (scored) {
    return { home: scored[1].trim(), away: scored[4].trim() };
  }
  return { home: text, away: '' };
}

function resolveTeams(record, records = []) {
  const teams = splitTeams(record.matchTeams);
  if (teams.home && teams.away) return teams;
  if (!teams.home) return teams;
  // 旧数据偶尔有一条记录只写了主队，另一条同日期/联赛的记录有完整对阵。
  const candidate = records.find((other) => {
    if (other === record) return false;
    if (cleanText(other.league) !== cleanText(record.league)) return false;
    if (cleanText(other.matchTime) !== cleanText(record.matchTime)) return false;
    if (record.kickoffTime && other.kickoffTime && cleanText(other.kickoffTime) !== cleanText(record.kickoffTime)) return false;
    const otherTeams = splitTeams(other.matchTeams);
    return otherTeams.home === teams.home && Boolean(otherTeams.away);
  });
  if (!candidate) return teams;
  const otherTeams = splitTeams(candidate.matchTeams);
  return { home: teams.home, away: otherTeams.away, inferred: true };
}

function parseMatchDate(value) {
  const match = cleanText(value).match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 20, 0, 0);
}

function parseKickoffTime(value) {
  const text = cleanText(value);
  if (!text) return null;
  const match = text.match(/(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2})\s*[点时:]\s*(\d{1,2})?/);
  if (!match) return null;
  let hour = Number(match[2]);
  const minute = Number(match[3] || 0);
  const period = match[1] || '';
  if (['下午', '傍晚', '晚上'].includes(period) && hour < 12) hour += 12;
  if (period === '中午' && hour < 11) hour += 12;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function parseSeasonRound(matchTime, league) {
  const text = cleanText(matchTime);
  const round = text.match(/(\d+)\s*轮/);
  const season = text.match(/^(\d{4})/);
  return {
    season: season ? season[1] : '',
    roundLabel: round ? round[1] : '',
    league: cleanText(league) || text.replace(/^\d{4}/, '').replace(/\d+\s*轮.*$/, '').trim()
  };
}

function parseScore(value) {
  const match = cleanText(value).match(/(\d+)\s*[-:]\s*(\d+)/);
  if (!match) return null;
  const homeGoals = Number(match[1]);
  const awayGoals = Number(match[2]);
  if (!Number.isInteger(homeGoals) || !Number.isInteger(awayGoals)) return null;
  return { homeGoals, awayGoals };
}

function lineFromText(value) {
  const text = cleanText(value);
  if (!text) return null;
  const signed = text.match(/([+-])\s*(\d+(?:\.\d+)?)/);
  if (signed) return Number(`${signed[1]}${signed[2]}`);
  if (/受\s*让/.test(text)) {
    const number = text.match(/受\s*让\s*(\d+(?:\.\d+)?)/);
    return number ? Number(number[1]) : null;
  }
  if (/让/.test(text)) {
    const number = text.match(/让\s*(\d+(?:\.\d+)?)/);
    return number ? -Number(number[1]) : null;
  }
  return null;
}

function sectionKind(label) {
  const text = cleanText(label);
  if (TIME_LABELS.has(text)) return TIME_LABELS.get(text);
  if (/^(变化|变盘|调整)/.test(text)) return 'change';
  return 'change';
}

function splitSections(raw) {
  const lines = cleanText(raw).split('\n').map((line) => line.trim()).filter(Boolean);
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (TIME_HEADER.test(line)) {
      current = { label: line, kind: sectionKind(line), lines: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      current = { label: '初始', kind: 'initial', lines: [] };
      sections.push(current);
    }
    current.lines.push(line);
  }
  return sections.filter((section) => section.lines.length);
}

function parseSpfOdds(text) {
  const home = text.match(/(?:主胜|胜)\s*([\d.]+)/);
  const draw = text.match(/(?:平局|平)\s*([\d.]+)/);
  const away = text.match(/(?:客胜|负)\s*([\d.]+)/);
  if (!home || !draw || !away) {
    const numbers = [...text.matchAll(/(?<![\d.])(\d{1,3}\.\d{1,2})(?![\d.])/g)]
      .map((match) => Number(match[1]))
      .filter((number) => number > 1);
    if (numbers.length < 3) return null;
    return { home: numbers[0], draw: numbers[1], away: numbers[2] };
  }
  const odds = {
    home: Number(home[1]),
    draw: Number(draw[1]),
    away: Number(away[1])
  };
  return Object.values(odds).every((number) => Number.isFinite(number) && number > 1) ? odds : null;
}

function parseTotalsOdds(text) {
  const odds = {};
  for (const match of text.matchAll(/(\d+)\s*\+?\s*球?\s+([\d.]+)/g)) {
    const key = match[1] === '7' || /^7\+/.test(match[0]) ? '7+' : String(Number(match[1]));
    const value = Number(match[2]);
    if (Number.isFinite(value) && value > 1) odds[key] = value;
  }
  return Object.keys(odds).length ? odds : null;
}

function parseScoreOdds(text) {
  const odds = {};
  for (const match of text.matchAll(/(\d+)\s*[:：-]\s*(\d+)\s+([\d.]+)/g)) {
    const key = `${Number(match[1])}:${Number(match[2])}`;
    const value = Number(match[3]);
    if (Number.isFinite(value) && value > 1) odds[key] = value;
  }
  for (const [label, key] of Object.entries(SPECIAL_SCORE)) {
    const match = text.match(new RegExp(`${label}\\s+([\\d.]+)`));
    if (match && Number(match[1]) > 1) odds[key] = Number(match[1]);
  }
  return Object.keys(odds).length ? odds : null;
}

function parseHalfFullOdds(text) {
  const odds = {};
  for (const [label, key] of Object.entries(HALF_FULL)) {
    const match = text.match(new RegExp(`${label}\\s+([\\d.]+)`));
    if (match && Number(match[1]) > 1) odds[key] = Number(match[1]);
  }
  return Object.keys(odds).length ? odds : null;
}

function snapshotTimes(kickoff, sections) {
  const total = sections.length;
  const kickoffMs = kickoff.getTime();
  return sections.map((section, index) => {
    if (section.kind === 'initial' || index === 0) {
      return new Date(kickoffMs - (total === 1 ? 60 : 24 * 60) * 60000).toISOString();
    }
    if (section.kind === 'closing' || index === total - 1) {
      return new Date(kickoffMs - 5 * 60000).toISOString();
    }
    const span = 24 * 60 - 10;
    return new Date(kickoffMs - (24 * 60 - (span * index) / Math.max(1, total - 1)) * 60000).toISOString();
  });
}

function buildSnapshots(raw, kickoff, parser, sourceLabel) {
  const sections = splitSections(raw);
  if (!sections.length) return [];
  const times = snapshotTimes(kickoff, sections);
  return sections.flatMap((section, index) => {
    const odds = parser(section.lines.join('\n'));
    if (!odds) return [];
    return [{
      ...createSnapshot({
        publishedAt: times[index],
        capturedAt: nowIso(),
        odds,
        rawText: section.lines.join('\n'),
        isClosing: section.kind === 'closing' || index === sections.length - 1,
        source: 'legacy'
      }),
      legacyLabel: section.label,
      legacySource: sourceLabel
    }];
  });
}

function buildMarkets(record) {
  const kickoff = parseMatchDate(record.date) || new Date();
  const time = parseKickoffTime(record.kickoffTime);
  if (time) kickoff.setHours(time.hour, time.minute, 0, 0);
  const markets = [];
  const raw = cleanText(record.spfRaw);

  if (record.panType === 'handicap') {
    const line = lineFromText(record.euroHc)
      ?? lineFromText(record.regularHc)
      ?? lineFromText(raw.split('\n')[0]);
    if (Number.isFinite(Number(line))) {
      const snapshots = buildSnapshots(raw, kickoff, parseSpfOdds, 'spfRaw');
      if (snapshots.length) {
        markets.push(createMarket('handicap', { line: Number(line), snapshots }));
      } else if (record.hcOdds && Object.values(record.hcOdds).every((value) => Number(value) > 1)) {
        markets.push(createMarket('handicap', {
          line: Number(line),
          snapshots: [createSnapshot({
            publishedAt: new Date(kickoff.getTime() - 5 * 60000).toISOString(),
            odds: {
              home: Number(record.hcOdds.w),
              draw: Number(record.hcOdds.d),
              away: Number(record.hcOdds.l)
            },
            source: 'legacy',
            isClosing: true,
            rawText: ''
          })]
        }));
      }
    }
  } else {
    const snapshots = buildSnapshots(raw, kickoff, parseSpfOdds, 'spfRaw');
    if (snapshots.length) markets.push(createMarket('spf', { snapshots }));
  }

  const totals = buildSnapshots(record.goalsRaw, kickoff, parseTotalsOdds, 'goalsRaw');
  if (totals.length) markets.push(createMarket('totals', { snapshots: totals }));
  const score = buildSnapshots(record.scoreRaw, kickoff, parseScoreOdds, 'scoreRaw');
  if (score.length) markets.push(createMarket('score', { snapshots: score }));
  const halfFull = buildSnapshots(record.hfRaw, kickoff, parseHalfFullOdds, 'hfRaw');
  if (halfFull.length) markets.push(createMarket('halfFull', { snapshots: halfFull }));
  return { markets, kickoff };
}

function resultOf(record) {
  const score = parseScore(record.matchScore);
  if (!score) return null;
  return {
    status: 'finished',
    homeGoals: score.homeGoals,
    awayGoals: score.awayGoals,
    htHome: null,
    htAway: null,
    settledAt: nowIso(),
    note: '旧版导入，半场比分未提供'
  };
}

function groupKey(record, records = []) {
  const teams = resolveTeams(record, records);
  return [
    teams.home.toLowerCase(),
    teams.away.toLowerCase(),
    cleanText(record.league),
    cleanText(record.matchTime) || cleanText(record.date)
  ].join('|');
}

function pickPrimary(records) {
  return [...records].sort((a, b) => {
    const scoreA = (a.panType === 'normal' ? 2 : 1) + (a.result ? 1 : 0);
    const scoreB = (b.panType === 'normal' ? 2 : 1) + (b.result ? 1 : 0);
    if (scoreB !== scoreA) return scoreB - scoreA;
    // 同场多条旧记录时，优先采用较新的保存记录（通常包含修正后的赛果）。
    return (parseMatchDate(b.date)?.getTime() || 0) - (parseMatchDate(a.date)?.getTime() || 0);
  })[0];
}

function mergeGroup(records, allRecords = records) {
  const primary = pickPrimary(records);
  const teams = resolveTeams(primary, allRecords);
  if (!teams.home || !teams.away) return null;
  const date = parseMatchDate(primary.date) || new Date();
  const time = parseKickoffTime(primary.kickoffTime);
  if (time) date.setHours(time.hour, time.minute, 0, 0);
  const seasonRound = parseSeasonRound(primary.matchTime, primary.league);
  const matchId = `legacy_${hashString(groupKey(primary, allRecords))}`;
  const markets = new Map();
  const warnings = [];
  if (teams.inferred) {
    warnings.push(`${teams.home} 的客队名缺失，已按同日同联赛记录补齐为 ${teams.away}`);
  }
  const scoreKeys = [...new Set(records
    .map((record) => parseScore(record.matchScore))
    .filter(Boolean)
    .map((score) => `${score.homeGoals}:${score.awayGoals}`))];
  if (scoreKeys.length > 1) {
    warnings.push(`${teams.home} vs ${teams.away} 有 ${scoreKeys.length} 个不同赛果（${scoreKeys.join('、')}），已取最新保存记录，请核对`);
  }

  for (const record of records) {
    if (!record.spfRaw && !record.goalsRaw && !record.scoreRaw && !record.hfRaw) {
      warnings.push(`${record.id || '旧记录'} 没有原始赔率文本，跳过`);
      continue;
    }
    const built = buildMarkets(record);
    for (const market of built.markets) {
      const key = `${market.type}|${market.line ?? ''}`;
      const current = markets.get(key);
      if (!current || market.snapshots.length > current.snapshots.length) {
        markets.set(key, market);
      }
    }
  }

  if (!teams.home || !teams.away) {
    warnings.push(`球队名无法拆分：${primary.matchTeams || '(空)'}`);
    return null;
  }

  const match = createMatch({
    matchId,
    home: teams.home,
    away: teams.away,
    league: seasonRound.league || primary.league,
    season: seasonRound.season,
    roundLabel: seasonRound.roundLabel,
    kickoff: date.toISOString(),
    matchNum: primary.matchTime && /周[一二三四五六日]\d+/.test(primary.matchTime)
      ? primary.matchTime.match(/周[一二三四五六日]\d+/)[0]
      : '',
    note: '旧版数据导入'
  });
  match.markets = [...markets.values()];
  match.result = resultOf(primary);
  match.status = match.result ? 'finished' : 'scheduled';
  if (match.result) {
    for (const market of match.markets) {
      market.settlementStatus = market.type === 'halfFull' ? 'pending' : 'settled';
    }
  }
  match.legacy = {
    source: 'jingcai_odds_pro',
    importedAt: nowIso(),
    timeApprox: true,
    recordIds: records.map((record) => record.id || null).filter(Boolean),
    duplicateRecordIds: records.length > 1
      ? records.filter((record) => record !== primary).map((record) => record.id || null).filter(Boolean)
      : [],
    records: records.map((record) => ({
      id: record.id || null,
      date: record.date || '',
      matchTime: record.matchTime || '',
      kickoffTime: record.kickoffTime || '',
      panType: record.panType || '',
      euroHc: record.euroHc || '',
      regularHc: record.regularHc || '',
      matchResult: record.matchResult || '',
      matchScore: record.matchScore || '',
      hcResult: record.hcResult || '',
      raw: {
        spf: record.spfRaw || '',
        goals: record.goalsRaw || '',
        score: record.scoreRaw || '',
        halfFull: record.hfRaw || ''
      },
      computed: {
        result: record.result || null,
        poisson: record.poisson || null,
        handicap: record.handicap || null,
        goals: record.goals || null,
        score: record.score || null,
        halfFull: record.hf || null,
        bayes: record.bayes || null
      }
    }))
  };
  match.audit.push({ at: nowIso(), action: 'import-legacy', detail: `旧版记录 ${records.length} 条` });
  return { match, warnings, primary };
}

export function legacyToMatches(input, { now = new Date() } = {}) {
  const records = Array.isArray(input)
    ? input
    : Array.isArray(input?.records)
      ? input.records
      : null;
  if (!records) throw new Error('不是旧版数据：应为记录数组或包含 records 数组');
  const groups = new Map();
  const warnings = [];
  let skipped = 0;

  for (const record of records) {
    if (!record || typeof record !== 'object') {
      skipped += 1;
      warnings.push('发现一条非对象记录，已跳过');
      continue;
    }
    const key = groupKey(record, records);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }

  const matches = [];
  for (const group of groups.values()) {
    const merged = mergeGroup(group, records);
    if (!merged) {
      skipped += 1;
      warnings.push(`跳过无法合并的记录组：${group[0]?.matchTeams || '(空)'}`);
      continue;
    }
    matches.push(merged.match);
    warnings.push(...merged.warnings);
  }

  matches.sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
  const uniqueWarnings = [...new Set(warnings)];
  return {
    matches,
    warnings: uniqueWarnings,
    summary: {
      records: records.length,
      matches: matches.length,
      markets: matches.reduce((sum, match) => sum + match.markets.length, 0),
      skipped,
      warnings: uniqueWarnings
    }
  };
}
