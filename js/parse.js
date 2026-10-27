const SCORE_SPECIAL = {
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

const HEADINGS = [
  { type: 'score', re: /比\s*分/ },
  { type: 'halfFull', re: /半\s*全\s*场/ },
  { type: 'totals', re: /总\s*进\s*球/ },
  { type: 'handicap', re: /让\s*球/ },
  { type: 'spf', re: /胜\s*平\s*负/ }
];

export function normalizeText(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[＋]/g, '+')
    .replace(/[－—–]/g, '-')
    .replace(/：/g, ':')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function headingOf(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 36) return null;
  if (/\d+\.\d+/.test(trimmed)) return null;
  for (const item of HEADINGS) {
    if (item.re.test(trimmed)) return item.type;
  }
  return null;
}

function inferMarket(text) {
  const cleaned = withoutTimestamps(text);
  if (/胜其他|平其他|负其他/.test(cleaned)) return 'score';
  if ((cleaned.match(/\d+\s*:\s*\d+/g) || []).length >= 3) return 'score';
  if ((cleaned.match(/(?:胜胜|胜平|胜负|平胜|平平|平负|负胜|负平|负负)/g) || []).length >= 3) {
    return 'halfFull';
  }
  if (/7\+/.test(cleaned) && /(?:^|\n)\s*0\s*球?\s*[\d.]+/m.test(cleaned)) return 'totals';
  if (/受\s*让|让\s*\d|让球|[+-]\s*\d+(?:\.\d+)?/.test(cleaned)
    && /胜/.test(cleaned) && /平/.test(cleaned) && /负/.test(cleaned)) {
    return 'handicap';
  }
  if (/胜/.test(cleaned) && /平/.test(cleaned) && /负/.test(cleaned)) return 'spf';
  return null;
}

function timestampOf(text, fallbackYear = new Date().getFullYear()) {
  let match = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) {
    match = text.match(/(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!match) return null;
    const [, month, day, hour, minute, second = '0'] = match;
    const date = new Date(fallbackYear, Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const [, year, month, day, hour, minute, second = '0'] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseNumber(value) {
  const number = Number(String(value).replace(/[^\d.]/g, ''));
  return Number.isFinite(number) && number > 1 ? Math.round(number * 100) / 100 : null;
}

function withoutTimestamps(block) {
  return block
    .replace(/\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?/g, ' ')
    .replace(/\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?/g, ' ');
}

function parseSpf(block) {
  const cleaned = withoutTimestamps(block);
  const match = cleaned.match(/(?:主胜|胜)\s*([\d.]+)\s*(?:平局|平)\s*([\d.]+)\s*(?:客胜|负)\s*([\d.]+)/)
    || cleaned.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (!match) return null;
  const [home, draw, away] = match.slice(1).map(parseNumber);
  if (!home || !draw || !away) return null;
  return { home, draw, away };
}

function parseHandicap(block, lineHint = null) {
  let line = null;
  const cleaned = withoutTimestamps(block);
  const signed = cleaned.match(/([+-]\s*\d+(?:\.\d+)?)/);
  if (signed) {
    line = Number(signed[1].replace(/\s/g, ''));
  } else {
    const receive = cleaned.match(/受\s*让\s*(\d+(?:\.\d+)?)/);
    const give = cleaned.match(/让\s*(\d+(?:\.\d+)?)/);
    if (receive) line = Number(receive[1]);
    else if (give) line = -Number(give[1]);
  }
  if (lineHint !== null && lineHint !== undefined && Number.isFinite(Number(lineHint))) {
    line = Number(lineHint);
  }
  const odds = parseSpf(block);
  if (!odds) return null;
  if (!Number.isFinite(line)) {
    return { line: null, odds, warning: '没有识别到让球数，请在保存前填写' };
  }
  return { line, odds };
}

function parseTotals(block) {
  const cleaned = block
    .replace(/\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?/g, ' ')
    .replace(/发布\s*时间|发布时间|固定奖金|总进球/g, ' ');
  const odds = {};
  const re = /(?:^|\s)(\d+\+?)\s*球?\s*([\d.]+)(?=\s|$)/g;
  let match;
  while ((match = re.exec(cleaned))) {
    const key = match[1];
    const value = parseNumber(match[2]);
    if (value && /^(?:[0-7]|7\+)$/.test(key)) {
      odds[key] = value;
    }
  }
  if (!Object.keys(odds).length) return null;
  return odds;
}

function parseScore(block) {
  const odds = {};
  const cleaned = withoutTimestamps(block);
  const re = /(\d+\s*:\s*\d+|胜其他|平其他|负其他)\s*([\d.]+)/g;
  let match;
  while ((match = re.exec(cleaned))) {
    const key = match[1].replace(/\s/g, '');
    const value = parseNumber(match[2]);
    if (!value) continue;
    odds[SCORE_SPECIAL[key] || key] = value;
  }
  return Object.keys(odds).length ? odds : null;
}

function parseHalfFull(block) {
  const odds = {};
  const re = /(胜胜|胜平|胜负|平胜|平平|平负|负胜|负平|负负)\s*([\d.]+)/g;
  let match;
  while ((match = re.exec(block))) {
    const key = HALF_FULL[match[1]];
    const value = parseNumber(match[2]);
    if (key && value) odds[key] = value;
  }
  return Object.keys(odds).length ? odds : null;
}

function parseSection(type, text, { lineHint = null, fallbackYear } = {}) {
  const warnings = [];
  const snapshots = [];
  const textWithBreaks = text.trim();
  if (!textWithBreaks) {
    return { type, line: null, snapshots: [], warnings: ['这一版块没有内容'] };
  }

  const stampRe = /(\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?|\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)/g;
  const stamps = [...textWithBreaks.matchAll(stampRe)];
  const blocks = [];

  if (!stamps.length) {
    blocks.push({ raw: textWithBreaks, publishedAt: null });
  } else {
    for (let index = 0; index < stamps.length; index += 1) {
      const start = stamps[index].index;
      const end = stamps[index + 1]?.index ?? textWithBreaks.length;
      blocks.push({
        raw: textWithBreaks.slice(start, end).trim(),
        publishedAt: timestampOf(stamps[index][0], fallbackYear)
      });
    }
    if (stamps[0].index > 0) {
      const prefix = textWithBreaks.slice(0, stamps[0].index).trim();
      if (prefix) blocks[0].raw = `${prefix}\n${blocks[0].raw}`;
    }
  }

  let resolvedLine = null;
  for (const block of blocks) {
    let odds = null;
    let blockLine = null;
    if (type === 'spf') {
      odds = parseSpf(block.raw);
    } else if (type === 'handicap') {
      const parsed = parseHandicap(block.raw, lineHint ?? resolvedLine);
      if (parsed?.warning) warnings.push(parsed.warning);
      if (parsed) {
        odds = parsed.odds;
        blockLine = parsed.line;
        if (Number.isFinite(blockLine)) resolvedLine = blockLine;
      }
    } else if (type === 'totals') {
      odds = parseTotals(block.raw);
    } else if (type === 'score') {
      odds = parseScore(block.raw);
    } else if (type === 'halfFull') {
      odds = parseHalfFull(block.raw);
    }

    if (!odds) {
      warnings.push(block.publishedAt ? `${block.publishedAt} 这一条没有识别到赔率` : '没有识别到赔率');
      continue;
    }
    if (!block.publishedAt) warnings.push('有赔率没有识别到发布时间，保存前请补时间');
    snapshots.push({
      publishedAt: block.publishedAt,
      capturedAt: new Date().toISOString(),
      isClosing: false,
      odds,
      rawText: block.raw,
      source: 'paste'
    });
  }

  const line = type === 'handicap' ? (lineHint ?? resolvedLine) : null;
  const hasLine = line !== null && line !== undefined && line !== '' && Number.isFinite(Number(line));
  if (type === 'handicap' && !hasLine) {
    warnings.push('没有识别到让球数，请在保存前填写');
  }
  if (type === 'totals' && snapshots.some((snapshot) => Object.keys(snapshot.odds).length < 8)) {
    warnings.push('总进球通常有 8 个选项（0–7+），当前识别不完整');
  }
  if (type === 'score' && snapshots.some((snapshot) => Object.keys(snapshot.odds).length < 20)) {
    warnings.push('比分盘通常有 31 个选项，当前识别不完整');
  }
  if (type === 'halfFull' && snapshots.some((snapshot) => Object.keys(snapshot.odds).length < 9)) {
    warnings.push('半全场应有 9 个组合，当前识别不完整');
  }

  return {
    type,
    line: hasLine ? Number(line) : null,
    snapshots: snapshots.sort((a, b) => {
      const at = a.publishedAt ? Date.parse(a.publishedAt) : 0;
      const bt = b.publishedAt ? Date.parse(b.publishedAt) : 0;
      return at - bt;
    }),
    warnings
  };
}

/**
 * 把用户从竞彩页面复制的文本拆成玩法版块，再拆成时间点。
 * 输入可以只含一个玩法，也可以含多个“XX固定奖金”标题。
 */
export function parsePaste(text, { lineHint = null, marketType = null, now = new Date() } = {}) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return { sections: [], warnings: ['没有粘贴内容'], rawText: '' };
  }

  const lines = normalized.split('\n');
  const rawSections = [];
  let current = null;

  for (const line of lines) {
    const type = headingOf(line);
    if (type) {
      current = { type, lines: [] };
      rawSections.push(current);
      continue;
    }
    if (!current) {
      current = { type: null, lines: [] };
      rawSections.push(current);
    }
    current.lines.push(line);
  }

  const sections = [];
  const warnings = [];
  for (const raw of rawSections) {
    const body = raw.lines.join('\n').trim();
    if (!body) continue;
    const type = raw.type || marketType || inferMarket(body);
    if (!type) {
      warnings.push('有一段文字无法判断玩法，请加“胜平负/让球/总进球/比分/半全场”标题');
      continue;
    }
    const parsed = parseSection(type, body, {
      lineHint,
      fallbackYear: now.getFullYear()
    });
    if (!parsed.snapshots.length) {
      warnings.push(`${raw.type ? '已识别标题' : '自动判断'} ${type}，但没有解析出赔率`);
      continue;
    }
    sections.push({ ...parsed, rawText: body });
    warnings.push(...parsed.warnings);
  }

  if (!sections.length) {
    warnings.push('没有解析出任何赔率，请检查文本格式或手动填写');
  }

  return {
    sections,
    warnings: [...new Set(warnings)],
    rawText: normalized
  };
}

export function mergeSnapshots(existing = [], incoming = []) {
  const map = new Map();
  for (const snapshot of [...existing, ...incoming]) {
    const key = `${snapshot.publishedAt || 'unknown'}|${JSON.stringify(snapshot.odds)}`;
    if (!map.has(key)) map.set(key, snapshot);
  }
  return [...map.values()].sort((a, b) => {
    const at = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const bt = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    return at - bt;
  });
}
