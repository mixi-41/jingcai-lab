const OUTCOMES = ['home', 'draw', 'away'];

export const SIGNAL_LABELS = {
  home: '主胜',
  draw: '平局',
  away: '客胜'
};

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function validTriple(odds) {
  return OUTCOMES.every((key) => Number.isFinite(Number(odds?.[key])) && Number(odds[key]) > 1);
}

function parseTime(value) {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : null;
}

function cutoffTime(match) {
  return parseTime(match?.salesCutoffAt) ?? parseTime(match?.kickoff);
}

function normalized(odds) {
  const implied = {};
  let sum = 0;
  for (const key of OUTCOMES) {
    const value = 1 / Number(odds[key]);
    implied[key] = value;
    sum += value;
  }
  if (!Number.isFinite(sum) || sum <= 0) return null;
  return {
    probabilities: Object.fromEntries(OUTCOMES.map((key) => [key, implied[key] / sum])),
    sum
  };
}

function usableSnapshots(market, cutoff) {
  return [...(market?.snapshots || [])]
    .filter((snapshot) => validTriple(snapshot?.odds))
    .filter((snapshot) => {
      if (cutoff === null) return true;
      const at = parseTime(snapshot.publishedAt);
      return at === null || at <= cutoff;
    })
    .sort((a, b) => (parseTime(a.publishedAt) ?? 0) - (parseTime(b.publishedAt) ?? 0));
}

function pickMarket(match) {
  const markets = match?.markets || [];
  const spf = markets.find((market) => market.type === 'spf');
  if (spf) return spf;
  return markets
    .filter((market) => market.type === 'handicap')
    .sort((a, b) => Math.abs(Number(a.line)) - Math.abs(Number(b.line)))[0] || null;
}

function levelOf(margin) {
  if (margin >= 0.20) return '一边倒';
  if (margin >= 0.10) return '明显倾向';
  if (margin >= 0.04) return '轻微倾向';
  return '三项接近';
}

function movementOf(maxAbs) {
  if (maxAbs < 0.30) return '几乎没动';
  if (maxAbs < 1.5) return '小幅变化';
  if (maxAbs < 4) return '明显变化';
  if (maxAbs < 7) return '剧烈变化';
  return '极端变化';
}

function marketLabel(type, line) {
  if (type !== 'handicap') return '胜平负';
  const number = Number(line);
  return Number.isFinite(number)
    ? `让球 ${number > 0 ? '+' : ''}${number}`
    : '让球胜平负';
}

function outcomeLabel(type, key) {
  if (type !== 'handicap') return SIGNAL_LABELS[key];
  return key === 'home' ? '让胜' : key === 'draw' ? '让平' : '让负';
}

function lineLabelOf(type, line) {
  if (type !== 'handicap') return null;
  const number = Number(line);
  if (!Number.isFinite(number) || number === 0) return '平手';
  return number > 0 ? `主队受让 ${number} 球` : `主队让 ${Math.abs(number)} 球`;
}

/**
 * 只读市场信号：把当前竞彩赔率反推成去水概率，并比较开盘到临场的变化。
 * 不训练、不预测赛果，只解释“市场现在怎么定价、往哪边动”。
 */
function buildSignalFromMarket(match, market) {
  if (!market) return null;

  const cutoff = cutoffTime(match);
  const snapshots = usableSnapshots(market, cutoff);
  if (!snapshots.length) return null;

  const opening = snapshots[0];
  const latest = snapshots[snapshots.length - 1];
  const current = normalized(latest.odds);
  const start = normalized(opening.odds);
  if (!current || !start) return null;

  const ranked = OUTCOMES
    .map((key) => ({ key, label: outcomeLabel(market.type, key), probability: current.probabilities[key] }))
    .sort((a, b) => b.probability - a.probability);
  const favorite = ranked[0];
  const second = ranked[1];
  const margin = favorite.probability - second.probability;

  const movement = {};
  for (const key of OUTCOMES) {
    movement[key] = round1((current.probabilities[key] - start.probabilities[key]) * 100);
  }
  const maxMoveKey = OUTCOMES
    .map((key) => ({ key, value: Math.abs(movement[key]) }))
    .sort((a, b) => b.value - a.value)[0].key;
  const maxAbs = Math.abs(movement[maxMoveKey]);
  const single = snapshots.length === 1;

  return {
    marketType: market.type,
    line: market.type === 'handicap' ? Number(market.line) : null,
    marketLabel: marketLabel(market.type, market.line),
    lineLabel: lineLabelOf(market.type, market.line),
    sample: snapshots.length,
    single,
    openingAt: opening.publishedAt || null,
    latestAt: latest.publishedAt || null,
    odds: Object.fromEntries(OUTCOMES.map((key) => [key, Number(latest.odds[key])])),
    openOdds: Object.fromEntries(OUTCOMES.map((key) => [key, Number(opening.odds[key])])),
    probabilities: Object.fromEntries(OUTCOMES.map((key) => [key, round1(current.probabilities[key] * 100)])),
    openProbabilities: Object.fromEntries(OUTCOMES.map((key) => [key, round1(start.probabilities[key] * 100)])),
    returnRatePct: round1(100 / current.sum),
    overroundPct: round1((current.sum - 1) * 100),
    favorite,
    marginPct: round1(margin * 100),
    level: levelOf(margin),
    movement,
    maxMoveKey,
    maxMoveLabel: outcomeLabel(market.type, maxMoveKey),
    maxMovePct: movement[maxMoveKey],
    movementLevel: movementOf(maxAbs),
    note: single
      ? '目前只有 1 个有效时间点，先看市场定价；变化要等下一次录入。'
      : `最热 ${favorite.label}，变化最大 ${outcomeLabel(market.type, maxMoveKey)} ${movement[maxMoveKey] >= 0 ? '+' : ''}${movement[maxMoveKey]}pp。`,
    disclaimer: '市场信号只解释赔率，不是模型，不构成投注建议。'
  };
}

export function buildMarketSignal(match) {
  const market = pickMarket(match);
  return market ? buildSignalFromMarket(match, market) : null;
}

export function buildHandicapSignals(match) {
  const markets = (match?.markets || []).filter((market) => market.type === 'handicap');
  return markets
    .map((market) => buildSignalFromMarket(match, market))
    .filter(Boolean)
    .sort((a, b) => Number(a.line) - Number(b.line));
}

export function buildMarketSignals(match) {
  const markets = match?.markets || [];
  const signals = [];
  const spf = markets.find((market) => market.type === 'spf');
  if (spf) {
    const signal = buildSignalFromMarket(match, spf);
    if (signal) signals.push(signal);
  }
  signals.push(...buildHandicapSignals(match));
  return signals;
}
