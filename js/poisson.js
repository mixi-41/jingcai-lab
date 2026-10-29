/**
 * 旧版“泊松反推”的纯计算版本。
 * 只把已经去水的比分概率换算成 λ 和比分分布，不预测、不推荐。
 */

const MAX_GOALS = 6;
const OUTCOMES = ['home', 'draw', 'away'];

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function factorial(n) {
  let value = 1;
  for (let i = 2; i <= n; i += 1) value *= i;
  return value;
}

function poisson(lambda, goals) {
  return Math.exp(-lambda) * (lambda ** goals) / factorial(goals);
}

function exactScore(key) {
  const match = /^(\d+):(\d+)$/.exec(String(key || ''));
  if (!match) return null;
  return { home: Number(match[1]), away: Number(match[2]) };
}

/**
 * 从完整比分盘反推主客 λ，再生成泊松比分矩阵。
 * @param {{score?: {complete?: boolean, allOptions?: Array}}} implied buildImpliedMarkets 的结果
 */
export function buildPoissonProjection(implied) {
  const score = implied?.score;
  if (!score?.complete || !Array.isArray(score.allOptions)) return null;

  let sum = 0;
  let homeGoals = 0;
  let awayGoals = 0;
  for (const option of score.allOptions) {
    const parsed = exactScore(option.key);
    if (!parsed) continue;
    const probability = Number(option.probabilityPct) / 100;
    if (!(probability > 0)) continue;
    sum += probability;
    homeGoals += parsed.home * probability;
    awayGoals += parsed.away * probability;
  }
  if (!(sum > 0)) return null;

  const lambdaHome = homeGoals / sum;
  const lambdaAway = awayGoals / sum;
  if (!(lambdaHome > 0) || !(lambdaAway > 0)) return null;

  let matrixTotal = 0;
  const matrix = [];
  const outcome = { home: 0, draw: 0, away: 0 };
  const totals = Array.from({ length: MAX_GOALS + 2 }, () => 0);
  for (let home = 0; home <= MAX_GOALS; home += 1) {
    matrix[home] = [];
    for (let away = 0; away <= MAX_GOALS; away += 1) {
      const probability = poisson(lambdaHome, home) * poisson(lambdaAway, away);
      matrix[home][away] = probability;
      matrixTotal += probability;
      const totalGoals = home + away;
      totals[totalGoals <= MAX_GOALS ? totalGoals : MAX_GOALS + 1] += probability;
      if (home > away) outcome.home += probability;
      else if (home === away) outcome.draw += probability;
      else outcome.away += probability;
    }
  }
  if (!(matrixTotal > 0)) return null;

  const top = [];
  for (let home = 0; home <= MAX_GOALS; home += 1) {
    for (let away = 0; away <= MAX_GOALS; away += 1) {
      top.push({ home, away, probabilityPct: round1((matrix[home][away] / matrixTotal) * 100) });
    }
  }
  top.sort((a, b) => b.probabilityPct - a.probabilityPct);

  const totalPct = totals.map((value) => (value / matrixTotal) * 100);
  const overUnder = [1.5, 2.5, 3.5].map((line) => {
    const over = totalPct.reduce((sumValue, value, goals) => goals > line ? sumValue + value : sumValue, 0);
    return { line, overPct: round1(over), underPct: round1(100 - over) };
  });

  return {
    lambdaHome: round2(lambdaHome),
    lambdaAway: round2(lambdaAway),
    total: round2(lambdaHome + lambdaAway),
    top: top.slice(0, 5).map((item) => ({
      label: `${item.home}:${item.away}`,
      probabilityPct: item.probabilityPct
    })),
    outcomes: Object.fromEntries(OUTCOMES.map((key) => [key, round1((outcome[key] / matrixTotal) * 100)])),
    totals: totalPct.map((value, goals) => ({
      goals,
      label: goals === MAX_GOALS + 1 ? '7+' : String(goals),
      probabilityPct: round1(value)
    })),
    overUnder,
    sample: score.sample || 0
  };
}
