/**
 * 旧版 App 的贝叶斯 / AI 实验模型，迁到当前数据结构。
 * 明确保留旧版的小样本口径：贝叶斯 5 场起，AI 5 场起、300 轮、无正则。
 * 只用于研究，不进正式统计，也不构成投注建议。
 */

const OUTCOMES = ['home', 'draw', 'away'];
const OUTCOME_LABELS = { home: '主胜', draw: '平局', away: '客胜' };

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function parseTime(value) {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : null;
}

function cutoffTime(match) {
  return parseTime(match?.salesCutoffAt) ?? parseTime(match?.kickoff);
}

function validTriple(odds) {
  return OUTCOMES.every((key) => Number.isFinite(Number(odds?.[key])) && Number(odds[key]) > 1);
}

function completeResult(match) {
  return match?.status === 'finished'
    && Number.isFinite(Number(match.result?.homeGoals))
    && Number.isFinite(Number(match.result?.awayGoals));
}

function outcomeOf(match) {
  const home = Number(match.result.homeGoals);
  const away = Number(match.result.awayGoals);
  if (home > away) return 'home';
  if (home < away) return 'away';
  return 'draw';
}

function spfSnapshots(match) {
  const market = (match?.markets || []).find((item) => item.type === 'spf');
  const cutoff = cutoffTime(match);
  return [...(market?.snapshots || [])]
    .filter((snapshot) => validTriple(snapshot.odds))
    .filter((snapshot) => {
      if (cutoff === null) return true;
      const at = parseTime(snapshot.publishedAt);
      return at === null || at <= cutoff;
    })
    .sort((a, b) => (parseTime(a.publishedAt) ?? 0) - (parseTime(b.publishedAt) ?? 0));
}

function linearSlope(values) {
  const n = values.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  values.forEach((value, index) => {
    numerator += (index - xMean) * (value - yMean);
    denominator += (index - xMean) ** 2;
  });
  return denominator ? numerator / denominator : 0;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values) {
  const mean = average(values);
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function kellyScore(kelly) {
  return Math.max(0, 10 - Math.abs(kelly - 1) * 50);
}

function cvScore(cv) {
  return Math.max(0, 10 - cv * 200);
}

function slopeScore(slope) {
  return Math.max(0, 10 - Math.abs(slope) * 100);
}

/**
 * 按旧版 calcSpf 的口径，从最多两个以上时间点重建 15 维特征。
 * 没有足够的完整时间点则返回 null。
 */
export function buildExperimentalFeatures(match) {
  const snapshots = spfSnapshots(match);
  if (snapshots.length < 2) return null;

  const rows = snapshots.map((snapshot) => {
    const home = Number(snapshot.odds.home);
    const draw = Number(snapshot.odds.draw);
    const away = Number(snapshot.odds.away);
    const rate = 1 / (1 / home + 1 / draw + 1 / away);
    return { home, draw, away, rate };
  });
  const mean = {
    home: average(rows.map((row) => row.home)),
    draw: average(rows.map((row) => row.draw)),
    away: average(rows.map((row) => row.away))
  };
  const meanRate = average(rows.map((row) => row.rate));
  const latest = rows[rows.length - 1];
  const realKelly = {
    home: latest.home * (1 / mean.home) / meanRate,
    draw: latest.draw * (1 / mean.draw) / meanRate,
    away: latest.away * (1 / mean.away) / meanRate
  };
  const cv = {
    home: stdDev(rows.map((row) => row.home)) / mean.home,
    draw: stdDev(rows.map((row) => row.draw)) / mean.draw,
    away: stdDev(rows.map((row) => row.away)) / mean.away
  };
  const decay = {
    home: linearSlope(rows.map((row) => row.home * row.rate)),
    draw: linearSlope(rows.map((row) => row.draw * row.rate)),
    away: linearSlope(rows.map((row) => row.away * row.rate))
  };
  const scores = {
    home: kellyScore(realKelly.home) * 0.4 + cvScore(cv.home) * 0.3 + slopeScore(decay.home) * 0.3,
    draw: kellyScore(realKelly.draw) * 0.4 + cvScore(cv.draw) * 0.3 + slopeScore(decay.draw) * 0.3,
    away: kellyScore(realKelly.away) * 0.4 + cvScore(cv.away) * 0.3 + slopeScore(decay.away) * 0.3
  };
  const jcDev = (meanRate - 0.886) / 0.886;

  return {
    sample: snapshots.length,
    scores,
    realKelly,
    cv,
    decay,
    jcDev,
    vector: [
      scores.home, scores.draw, scores.away,
      realKelly.home, realKelly.draw, realKelly.away,
      cv.home, cv.draw, cv.away,
      decay.home, decay.draw, decay.away,
      jcDev, jcDev, jcDev
    ]
  };
}

function historySamples(history, excludeId) {
  return (history || [])
    .filter((match) => completeResult(match))
    .filter((match) => match.matchId !== excludeId)
    .map((match) => {
      const features = buildExperimentalFeatures(match);
      if (!features) return null;
      return { match, features, label: outcomeOf(match) };
    })
    .filter(Boolean);
}

export function buildBayes(match, history) {
  const features = buildExperimentalFeatures(match);
  if (!features) return null;
  const samples = historySamples(history, match.matchId);
  const n = samples.length;
  if (n < 5) return { sample: n, needMore: true };

  const counts = { home: 0, draw: 0, away: 0 };
  for (const sample of samples) counts[sample.label] += 1;
  const prior = {
    home: counts.home / n,
    draw: counts.draw / n,
    away: counts.away / n
  };
  const likeRaw = {
    home: Math.max(0, 10 - features.scores.home),
    draw: Math.max(0, 10 - features.scores.draw),
    away: Math.max(0, 10 - features.scores.away)
  };
  const likeSum = likeRaw.home + likeRaw.draw + likeRaw.away;
  if (!(likeSum > 0)) return null;
  const like = {
    home: likeRaw.home / likeSum,
    draw: likeRaw.draw / likeSum,
    away: likeRaw.away / likeSum
  };
  const weight = n >= 30 ? 0.3 : n >= 10 ? 0.2 : 0.1;
  const raw = {};
  for (const key of OUTCOMES) {
    raw[key] = (Math.max(prior[key], 1e-4) ** weight)
      * (Math.max(like[key], 1e-4) ** (1 - weight));
  }
  const sum = raw.home + raw.draw + raw.away;
  return {
    sample: n,
    prior,
    like,
    posterior: {
      home: raw.home / sum,
      draw: raw.draw / sum,
      away: raw.away / sum
    },
    weight
  };
}

function softmax(values) {
  const max = Math.max(...values);
  const exps = values.map((value) => Math.exp(value - max));
  const sum = exps.reduce((total, value) => total + value, 0);
  return exps.map((value) => value / sum);
}

function predict(features, model) {
  const logits = [0, 1, 2].map((index) => {
    let value = model.bias[index];
    for (let i = 0; i < features.length; i += 1) {
      value += features[i] * model.weights[i][index];
    }
    return value;
  });
  return softmax(logits);
}

function train(samples, featureSize) {
  let seed = 42;
  const random = () => {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const weights = Array.from({ length: featureSize }, () =>
    Array.from({ length: 3 }, () => (random() - 0.5) * 0.01));
  const bias = [0, 0, 0];

  for (let epoch = 0; epoch < 300; epoch += 1) {
    const gradW = Array.from({ length: featureSize }, () => [0, 0, 0]);
    const gradB = [0, 0, 0];
    for (const sample of samples) {
      const predicted = predict(sample.features.vector, { weights, bias });
      const target = sample.label === 'home' ? 0 : sample.label === 'draw' ? 1 : 2;
      for (let j = 0; j < 3; j += 1) {
        const error = predicted[j] - (j === target ? 1 : 0);
        gradB[j] += error;
        for (let i = 0; i < featureSize; i += 1) {
          gradW[i][j] += error * sample.features.vector[i];
        }
      }
    }
    const n = samples.length;
    for (let j = 0; j < 3; j += 1) {
      bias[j] -= 0.05 * gradB[j] / n;
      for (let i = 0; i < featureSize; i += 1) {
        weights[i][j] -= 0.05 * gradW[i][j] / n;
      }
    }
  }
  return { weights, bias };
}

export function buildAi(match, history) {
  const features = buildExperimentalFeatures(match);
  if (!features) return null;
  const samples = historySamples(history, match.matchId);
  if (samples.length < 5) return { sample: samples.length, needMore: true };
  const model = train(samples, 15);
  const probabilities = predict(features.vector, model);
  return {
    sample: samples.length,
    probabilities: {
      home: probabilities[0],
      draw: probabilities[1],
      away: probabilities[2]
    }
  };
}

export function buildExperimentalModels(match, history) {
  const bayes = buildBayes(match, history);
  const ai = buildAi(match, history);
  if (!bayes && !ai) return null;
  return { bayes, ai };
}

export { OUTCOME_LABELS, round1 };
