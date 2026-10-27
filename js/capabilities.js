const percent = (value) => Math.max(0, Math.min(100, Math.round(value * 100)));

function snapshotTime(snapshot) {
  const value = snapshot?.publishedAt || snapshot?.capturedAt;
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/**
 * 收盘快照优先看显式 isClosing 标记；没有标记时，
 * 用“停售前最后一个时间点”作为代理，避免把开赛后/停售后补录当成收盘。
 * 竞彩可能提前几小时停售，因此销售截止时间优先于开赛时间。
 */
export function hasClosingSnapshot(match, market) {
  const snapshots = market?.snapshots || [];
  if (snapshots.length === 0) return false;
  const cutoff = Date.parse(match?.salesCutoffAt || match?.kickoff || '');
  const times = snapshots.map(snapshotTime).filter((time) => time !== null);

  const explicit = snapshots.filter((snapshot) => snapshot.isClosing);
  if (explicit.length) {
    if (!Number.isFinite(cutoff)) return true;
    return explicit.some((snapshot) => {
      const time = snapshotTime(snapshot);
      return time !== null && time <= cutoff;
    });
  }

  if (!Number.isFinite(cutoff)) return false;
  return times.filter((time) => time <= cutoff).length >= 2;
}

function settledWithResult(match) {
  return match?.status === 'finished' && Boolean(match.result);
}

export function computeCapabilityMetrics(matches = []) {
  const active = matches.filter((match) => !match.deletedAt);
  const finished = active.filter((match) => match.status === 'finished');
  const settled = finished.filter(settledWithResult);
  const withOdds = active.filter((match) => (match.markets || []).some(
    (market) => (market.snapshots || []).length > 0
  ));
  const closing = settled.filter((match) => (match.markets || []).some(
    (market) => hasClosingSnapshot(match, market)
  ));

  const byLeague = new Map();
  for (const match of settled) {
    const league = String(match.league || '未分类').trim() || '未分类';
    byLeague.set(league, (byLeague.get(league) || 0) + 1);
  }
  let topLeague = '未分类';
  let topLeagueCount = 0;
  for (const [league, count] of byLeague) {
    if (count > topLeagueCount) {
      topLeague = league;
      topLeagueCount = count;
    }
  }

  return {
    matches: active.length,
    finished: finished.length,
    settled: settled.length,
    withOdds: withOdds.length,
    closing: closing.length,
    maxLeague: topLeague,
    maxLeagueCount: topLeagueCount,
    resultCoverage: finished.length ? settled.length / finished.length : 0,
    closingCoverage: settled.length ? closing.length / settled.length : 0,
    marketCoverage: active.length ? withOdds.length / active.length : 0,
    markets: active.reduce((sum, match) => sum + (match.markets || []).length, 0),
    snapshots: active.reduce((sum, match) => sum + (match.markets || []).reduce(
      (inner, market) => inner + (market.snapshots || []).length,
      0
    ), 0)
  };
}

const QUALITY = {
  closing: {
    key: 'closingCoverage',
    label: '收盘/赛前快照覆盖',
    gate: 0.9
  },
  result: {
    key: 'resultCoverage',
    label: '赛果完整率',
    gate: 0.95
  }
};

export const CAPABILITY_DEFINITIONS = [
  {
    id: 'basics',
    title: '基础指标',
    subtitle: '去水概率、相对价格、离散度',
    threshold: 1,
    metric: 'withOdds',
    countLabel: '有赔率的比赛',
    implemented: true,
    note: '至少有 1 场带赔率的比赛就能开始计算。'
  },
  {
    id: 'clv',
    title: '收盘基准与 CLV',
    subtitle: '看市场最后价格，而不是只看初盘',
    threshold: 30,
    metric: 'closing',
    countLabel: '有收盘/赛前快照的已结算比赛',
    quality: QUALITY.closing,
    implemented: true,
    note: '需要至少 30 场；没有 isClosing 标记时，用停售前最后一个时间点作为代理。'
  },
  {
    id: 'calibration',
    title: '概率校准',
    subtitle: '预测概率和真实结果是否对得上',
    threshold: 50,
    metric: 'settled',
    countLabel: '已结算比赛',
    quality: QUALITY.result,
    note: '50 场起看校准曲线、Brier 和 Log Loss。'
  },
  {
    id: 'backtest',
    title: '回测与模型对比',
    subtitle: '和收盘去水基准做时间外比较',
    threshold: 100,
    metric: 'settled',
    countLabel: '已结算比赛',
    quality: QUALITY.result,
    note: '100 场起才有资格谈“模型是否比收盘价更好”。'
  },
  {
    id: 'ai',
    title: 'AI 概率',
    subtitle: '只能当实验，不自动变成投注建议',
    threshold: 200,
    metric: 'settled',
    countLabel: '已结算比赛',
    quality: QUALITY.result,
    note: '200 场起训练；先在电脑离线训练，再导入 model.json。'
  },
  {
    id: 'league',
    title: '单联赛模型',
    subtitle: '该联赛独立建模，不混所有比赛',
    threshold: 300,
    metric: 'maxLeagueCount',
    countLabel: '最高联赛已结算比赛',
    quality: QUALITY.result,
    note: '任一联赛达到 300 场再单练；不够时先用全局模型 + 联赛修正。'
  },
  {
    id: 'auto',
    title: '自动学习',
    subtitle: 'champion / challenger 与版本回滚',
    threshold: 300,
    metric: 'settled',
    countLabel: '已结算比赛',
    quality: QUALITY.result,
    note: '300 场是起步；AI 上线后还要新增 100 场才值得自动重训。'
  }
];

export function buildCapabilityRows(metrics) {
  return CAPABILITY_DEFINITIONS.map((definition) => {
    const count = Number(metrics[definition.metric] || 0);
    const threshold = definition.threshold;
    const quality = definition.quality
      ? {
          label: definition.quality.label,
          value: Number(metrics[definition.quality.key] || 0),
          gate: definition.quality.gate,
          pass: Number(metrics[definition.quality.key] || 0) >= definition.quality.gate
        }
      : null;
    const countReady = count >= threshold;
    const qualityReady = !quality || quality.pass;
    const status = countReady && qualityReady ? 'ready' : countReady ? 'warn' : 'locked';
    const missing = countReady
      ? (qualityReady
        ? (definition.implemented ? '已接入，可直接使用' : '样本已够，待接入')
        : `${quality.label}需达到 ${percent(quality.gate)}%`)
      : `还差 ${threshold - count} 场`;

    return {
      ...definition,
      count,
      threshold,
      percent: Math.min(100, Math.round((count / threshold) * 100)),
      quality,
      status,
      missing
    };
  });
}

export function capabilitySummary(rows) {
  return {
    ready: rows.filter((row) => row.status === 'ready').length,
    implemented: rows.filter((row) => row.status === 'ready' && row.implemented).length,
    warn: rows.filter((row) => row.status === 'warn').length,
    total: rows.length
  };
}

export { percent };
