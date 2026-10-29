import { parsePaste } from './parse.js';

const MARKET_DEFS = [
  { type: 'spf', label: '胜平负', hint: '粘贴胜平负多时点文本；每段时间标签 + 胜/平/负三行。' },
  { type: 'handicap', label: '让球胜平负', hint: '填让球数，粘贴让球胜平负多时点文本；旧版只取最后一组。' },
  { type: 'totals', label: '总进球', hint: '粘贴总进球多时点文本（0–7+）。' },
  { type: 'score', label: '比分', hint: '粘贴波胆多时点文本（含胜其他/平其他/负其他）。' },
  { type: 'halfFull', label: '半全场', hint: '粘贴半全场 9 个结果；旧版只取最后一组。' }
];

const state = {
  meta: null,
  sections: null
};

function field(id, label, attrs = '') {
  return `<label for="${id}">${label}</label><input id="${id}" ${attrs}>`;
}

function dtHtml(prefix, label) {
  return `
    <fieldset class="b-dt">
      <legend>${label}</legend>
      <div class="b-dt-row">
        <input id="${prefix}-y" inputmode="numeric" maxlength="4" placeholder="年">
        <input id="${prefix}-m" inputmode="numeric" maxlength="2" placeholder="月">
        <input id="${prefix}-d" inputmode="numeric" maxlength="2" placeholder="日">
        <input id="${prefix}-h" inputmode="numeric" maxlength="2" placeholder="时">
        <input id="${prefix}-min" inputmode="numeric" maxlength="2" placeholder="分">
      </div>
      <div class="b-dt-labels"><span>年</span><span>月</span><span>日</span><span>时</span><span>分</span></div>
    </fieldset>`;
}

function panelHtml() {
  return `
  <div class="b-card">
    <h3>新版录入 · 旧版计算</h3>
    <p>用结构化字段和五个玩法文本录入；生成后仍走旧版计算、评分、AI 和贝叶斯。为了兼容旧版，时间点会按“初始/变化N/临场”顺序传入，真实分钟只保存在附加字段。</p>
    <div class="b-grid">
      ${field('b-home', '主队', 'placeholder="例如：巴库萨巴赫"')}
      ${field('b-away', '客队', 'placeholder="例如：多特蒙德"')}
    </div>
    <div class="b-grid">
      ${field('b-league', '联赛', 'placeholder="例如：欧冠"')}
      ${field('b-match-no', '竞彩编号', 'placeholder="例如：周二001"')}
    </div>
    <div class="b-grid">
      ${field('b-season', '赛季', 'placeholder="例如：2627"')}
      ${field('b-round', '轮次', 'placeholder="例如：8"')}
    </div>
    <input id="b-date" type="hidden">
    <input id="b-time" type="hidden">
    <input id="b-cutoff" type="hidden">
    ${dtHtml('b-kick', '开赛时间')}
    <p class="b-dt-hint">直接输入数字，例如 2026 / 10 / 24 / 13 / 00。</p>
    ${dtHtml('b-cut', '停售时间（可选）')}
    <p class="b-dt-hint">竞彩可能提前几小时停售；不填按开赛时间估算，并标为“代理”。</p>
    <div class="b-status" id="b-status">先填比赛信息，再粘贴至少一个玩法。</div>
  </div>
  <div class="b-card">
    <div class="b-markets">
      ${MARKET_DEFS.map((m) => `
        <details ${m.type === 'spf' ? 'open' : ''}>
          <summary>${m.label}</summary>
          <div class="b-body">
            ${m.type === 'handicap' ? `
              <div class="b-line-row">
                <label for="b-line">让球数（+1 受让 / -1 让球）</label>
                <input id="b-line" type="number" step="1" placeholder="例如：-1">
              </div>` : ''}
            <p class="b-tip">${m.hint}</p>
            <textarea id="b-${m.type}" placeholder="${m.hint}"></textarea>
            <div class="b-check-row">
              <button class="btn btn-secondary b-check" type="button" data-type="${m.type}">识别本卡</button>
              <span class="b-check-result" id="b-check-${m.type}"></span>
            </div>
          </div>
        </details>
      `).join('')}
    </div>
    <div class="b-actions" style="margin-top:12px">
      <button class="btn btn-primary" id="b-run" type="button">生成并计算</button>
      <button class="btn btn-secondary" id="b-clear" type="button">清空</button>
    </div>
  </div>`;
}

function parseOne(type) {
  const box = document.getElementById(`b-${type}`);
  const text = box?.value.trim();
  if (!text) return null;
  const lineHint = type === 'handicap' && document.getElementById('b-line')?.value !== ''
    ? Number(document.getElementById('b-line').value)
    : undefined;
  const result = parsePaste(text, { marketType: type, lineHint, now: new Date() });
  const section = result.sections.find((s) => s.type === type) || result.sections[0];
  if (!section || !section.snapshots.length) {
    throw new Error(`${type} 没有解析出有效赔率`);
  }
  return section;
}

function checkCard(type) {
  const el = document.getElementById(`b-check-${type}`);
  if (!el) return;
  try {
    const section = parseOne(type);
    if (!section) {
      el.textContent = '还没有内容';
      el.className = 'b-check-result';
      return;
    }
    const latest = section.snapshots[section.snapshots.length - 1];
    let detail = '';
    if (type === 'spf' || type === 'handicap') {
      detail = `最新 ${latest.odds.home.toFixed(2)} / ${latest.odds.draw.toFixed(2)} / ${latest.odds.away.toFixed(2)}`;
    } else {
      detail = `${Object.keys(latest.odds).length} 个选项`;
    }
    el.textContent = `识别通过：${section.snapshots.length} 个时间点 · ${detail}`;
    el.className = 'b-check-result ok';
  } catch (error) {
    el.textContent = `识别失败：${error.message}`;
    el.className = 'b-check-result error';
  }
}

function labelAt(index, length) {
  if (index === 0) return '初始';
  if (index === length - 1) return '临场';
  return `变化${index}`;
}

function eachSnapshot(section, fn) {
  const snapshots = [...section.snapshots].sort((a, b) => {
    const at = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const bt = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    return at - bt;
  });
  snapshots.forEach((snapshot, index) => fn(snapshot, labelAt(index, snapshots.length)));
}

function spfRaw(section) {
  const lines = [];
  eachSnapshot(section, (snapshot, label) => {
    lines.push(label);
    lines.push(`胜 ${snapshot.odds.home.toFixed(2)}`);
    lines.push(`平 ${snapshot.odds.draw.toFixed(2)}`);
    lines.push(`负 ${snapshot.odds.away.toFixed(2)}`);
  });
  return lines.join('\n');
}

function totalsRaw(section) {
  const lines = [];
  eachSnapshot(section, (snapshot, label) => {
    lines.push(label);
    for (const key of ['0', '1', '2', '3', '4', '5', '6', '7+']) {
      if (snapshot.odds[key] != null) lines.push(`${key} ${Number(snapshot.odds[key]).toFixed(2)}`);
    }
  });
  return lines.join('\n');
}

function scoreRaw(section) {
  const labels = { other_home: '胜其他', other_draw: '平其他', other_away: '负其他' };
  const lines = [];
  eachSnapshot(section, (snapshot, label) => {
    lines.push(label);
    for (const [key, value] of Object.entries(snapshot.odds)) {
      const name = labels[key] || key;
      lines.push(`${name} ${Number(value).toFixed(2)}`);
    }
  });
  return lines.join('\n');
}

const HF_LABELS = {
  home_home: '胜胜', home_draw: '胜平', home_away: '胜负',
  draw_home: '平胜', draw_draw: '平平', draw_away: '平负',
  away_home: '负胜', away_draw: '负平', away_away: '负负'
};

function hfRaw(section) {
  const snapshot = section.snapshots[section.snapshots.length - 1];
  return Object.entries(HF_LABELS)
    .filter(([key]) => snapshot.odds[key] != null)
    .map(([key, name]) => `${name} ${Number(snapshot.odds[key]).toFixed(2)}`)
    .join('\n');
}

function lineText(line) {
  if (line == null || line === 0) return '平手';
  return line > 0 ? `受让${Math.abs(line)}` : `主让${Math.abs(line)}`;
}

function setValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

function showStatus(text) {
  const el = document.getElementById('b-status');
  if (el) el.textContent = text;
}

function readDt(prefix, label, required = true) {
  const parts = ['y', 'm', 'd', 'h', 'min'].map((part) => document.getElementById(`${prefix}-${part}`)?.value.trim() || '');
  if (!parts.some(Boolean)) {
    if (required) throw new Error(`${label}要填完整（年/月/日/时/分）`);
    return null;
  }
  if (parts.some((value) => value === '')) throw new Error(`${label}要填完整（年/月/日/时/分）`);
  const [y, m, d, h, min] = parts.map(Number);
  if (!Number.isInteger(y) || y < 1900 || y > 2200) throw new Error(`${label}的年份不对`);
  if (!Number.isInteger(m) || m < 1 || m > 12) throw new Error(`${label}的月份不对`);
  if (!Number.isInteger(d) || d < 1 || d > 31) throw new Error(`${label}的日期不对`);
  if (!Number.isInteger(h) || h < 0 || h > 23) throw new Error(`${label}的小时不对`);
  if (!Number.isInteger(min) || min < 0 || min > 59) throw new Error(`${label}的分钟不对`);
  const date = new Date(y, m - 1, d, h, min);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) throw new Error(`${label}不是有效日期`);
  const pad = (value) => String(value).padStart(2, '0');
  return {
    date: `${y}-${pad(m)}-${pad(d)}`,
    time: `${pad(h)}:${pad(min)}`,
    iso: `${y}-${pad(m)}-${pad(d)}T${pad(h)}:${pad(min)}`
  };
}

function bindDtInputs(prefix) {
  const parts = ['y', 'm', 'd', 'h', 'min'];
  parts.forEach((part, index) => {
    const input = document.getElementById(`${prefix}-${part}`);
    if (!input) return;
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, part === 'y' ? 4 : 2);
      const max = part === 'y' ? 4 : 2;
      if (input.value.length >= max && parts[index + 1]) {
        document.getElementById(`${prefix}-${parts[index + 1]}`)?.focus();
      }
    });
  });
}

function clearDt(prefix) {
  for (const part of ['y', 'm', 'd', 'h', 'min']) {
    const el = document.getElementById(`${prefix}-${part}`);
    if (el) el.value = '';
  }
}

function clearInputs() {
  for (const id of ['b-home', 'b-away', 'b-league', 'b-match-no', 'b-season', 'b-round', 'b-date', 'b-time', 'b-cutoff', 'b-line']) {
    setValue(id, '');
  }
  clearDt('b-kick');
  clearDt('b-cut');
  for (const def of MARKET_DEFS) {
    setValue(`b-${def.type}`, '');
    const check = document.getElementById(`b-check-${def.type}`);
    if (check) check.textContent = '';
  }
  state.meta = null;
  state.sections = null;
  showStatus('已清空。');
}

function buildOldData() {
  const home = document.getElementById('b-home').value.trim();
  const away = document.getElementById('b-away').value.trim();
  if (!home || !away) throw new Error('主队和客队都要填');
  const sections = {};
  for (const def of MARKET_DEFS) {
    const section = parseOne(def.type);
    if (section) sections[def.type] = section;
  }
  if (!sections.spf) throw new Error('至少要有胜平负赔率，旧版计算以胜平负为入口');
  const spf = sections.spf;
  const handicap = sections.handicap;
  const totals = sections.totals;
  const score = sections.score;
  const halfFull = sections.halfFull;
  const explicitLine = document.getElementById('b-line').value.trim();
  const line = explicitLine !== '' ? Number(explicitLine) : (handicap?.line ?? null);
  if (handicap && !Number.isFinite(line)) throw new Error('让球盘要填整数让球数（例如 -1 / +1）');
  if (handicap && line != null) handicap.line = line;

  const kickoff = readDt('b-kick', '开赛时间', true);
  const cutoff = readDt('b-cut', '停售时间', false);
  setValue('b-date', kickoff.date);
  setValue('b-time', kickoff.time);
  setValue('b-cutoff', cutoff ? cutoff.iso : '');
  setValue('matchTeams', `${home} vs ${away}`);
  setValue('leagueName', document.getElementById('b-league').value.trim() || '未标注');
  setValue('matchTime', kickoff.date);
  setValue('kickoffTime', kickoff.time);
  setValue('spfText', spfRaw(spf));
  if (handicap) {
    const last = handicap.snapshots[handicap.snapshots.length - 1];
    setValue('hcOddsW', Number(last.odds.home).toFixed(2));
    setValue('hcOddsD', Number(last.odds.draw).toFixed(2));
    setValue('hcOddsL', Number(last.odds.away).toFixed(2));
    setValue('regularHc', lineText(line));
    setValue('euroHc', lineText(line));
    setValue('panType', 'handicap');
  } else {
    setValue('hcOddsW', '');
    setValue('hcOddsD', '');
    setValue('hcOddsL', '');
    setValue('regularHc', '');
    setValue('euroHc', '');
    setValue('panType', 'normal');
  }
  setValue('goalsText', totals ? totalsRaw(totals) : '');
  setValue('scoreText', score ? scoreRaw(score) : '');
  setValue('hfText', halfFull ? hfRaw(halfFull) : '');
  if (halfFull) window.parseHfText?.();

  state.sections = sections;
  state.meta = {
    bVersion: 1,
    season: document.getElementById('b-season').value.trim(),
    round: document.getElementById('b-round').value.trim(),
    matchNo: document.getElementById('b-match-no').value.trim(),
    salesCutoffAt: document.getElementById('b-cutoff').value || null,
    bMarkets: Object.fromEntries(Object.entries(sections).map(([type, section]) => [type, {
      line: section.line,
      snapshots: section.snapshots.map((snapshot) => ({
        publishedAt: snapshot.publishedAt,
        odds: snapshot.odds
      }))
    }]))
  };
  return { sections, line };
}

function run() {
  try {
    const { sections } = buildOldData();
    const missing = ['spf', 'handicap', 'totals', 'score', 'halfFull'].filter((type) => !sections[type]);
    showStatus(`已识别：${Object.keys(sections).join(' / ')}；旧版计算中…`);
    window.runAll?.();
    showStatus(`旧版已计算。${missing.length ? `未填：${missing.join(' / ')}。` : ''} 请到“分析结果”保存。`);
  } catch (error) {
    showStatus(`失败：${error.message}`);
    alert(error.message);
  }
}

function escHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function renderUnresulted() {
  const list = window.__bApp.getRecords().filter((record) => !record.matchResult || record.matchResult === 'un');
  const count = document.getElementById('b-unresulted-count');
  if (count) count.textContent = String(list.length);
  const badge = document.getElementById('b-unresulted-badge');
  if (badge) badge.textContent = `${list.length} 场`;
  const box = document.getElementById('b-unresulted-list');
  if (!box) return;
  if (!list.length) {
    box.innerHTML = '<div class="b-empty">没有未录入赛果的比赛。</div>';
    return;
  }
  box.innerHTML = list.map((record) => `
    <div class="b-unresulted-item">
      <div class="b-unresulted-main">
        <b>${escHtml(record.matchTeams || '未命名比赛')}</b>
        <small>${escHtml(record.league || '未标注')} · ${escHtml(record.date || '')} ${escHtml(record.kickoffTime || '')} · ${escHtml(record.panType === 'handicap' ? '让球盘' : '常规盘')}</small>
      </div>
      <div class="b-unresulted-actions">
        <button class="btn btn-secondary" type="button" onclick="editRecordDetail(${record.id})">详情</button>
        <button class="btn btn-primary" type="button" onclick="inputScore(${record.id})">录比分</button>
      </div>
    </div>`).join('');
}

function installUnresultedTab() {
  const nav = document.querySelector('.tabs');
  const aiTab = document.getElementById('tab-ai');
  if (!nav || !aiTab || document.getElementById('tab-unresulted')) return;
  const tab = document.createElement('div');
  tab.className = 'tab';
  tab.id = 'b-tab-unresulted';
  tab.innerHTML = '未录入 <span class="b-tab-count" id="b-unresulted-count">0</span>';
  tab.addEventListener('click', () => window.switchTab('unresulted'));
  nav.append(tab);

  const content = document.createElement('div');
  content.className = 'tab-content';
  content.id = 'tab-unresulted';
  content.innerHTML = `
    <div class="card">
      <div class="card-title">未录入赛果 <span class="badge" id="b-unresulted-badge">0 场</span></div>
      <p class="tip" style="margin-bottom:10px">已保存但还没录赛果的比赛；点“录比分”打开全场/半场弹窗。</p>
      <div id="b-unresulted-list"></div>
    </div>`;
  aiTab.insertAdjacentElement('afterend', content);

  const originalSwitch = window.switchTab;
  window.switchTab = function (name) {
    if (name === 'unresulted') {
      document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === tab));
      document.querySelectorAll('.tab-content').forEach((item) => item.classList.remove('active'));
      content.classList.add('active');
      renderUnresulted();
      return;
    }
    originalSwitch(name);
    tab.classList.remove('active');
  };
  renderUnresulted();
}

function fillDateTime(prefix, dateText, timeText) {
  const date = String(dateText || '').match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  const time = String(timeText || '').match(/(\d{1,2}):(\d{2})/);
  const values = date ? [date[1], date[2], date[3]] : ['', '', ''];
  if (time) values.push(time[1], time[2]);
  else values.push('', '');
  ['y', 'm', 'd', 'h', 'min'].forEach((part, index) => {
    const el = document.getElementById(`${prefix}-${part}`);
    if (el) el.value = values[index] || '';
  });
}

function sectionFromMeta(meta) {
  if (!meta || !Array.isArray(meta.snapshots)) return null;
  return {
    line: meta.line,
    snapshots: meta.snapshots.map((snapshot) => ({
      publishedAt: snapshot.publishedAt || '',
      odds: snapshot.odds || {}
    }))
  };
}

function installBackfillBridge() {
  const original = window.backfillRecord;
  if (typeof original !== 'function' || original.__bWrapped) return;
  const wrapped = function (id) {
    const record = window.__bApp?.getRecords().find((item) => item.id === id);
    if (record) {
      const teams = String(record.matchTeams || '').split(/\s+vs\s+/i);
      setValue('b-home', teams[0] || '');
      setValue('b-away', teams[1] || '');
      setValue('b-league', record.league === '未标注' ? '' : record.league || '');
      setValue('b-match-no', record.matchNo || '');
      setValue('b-season', record.season || '');
      setValue('b-round', record.round || '');
      fillDateTime('b-kick', record.matchTime, record.kickoffTime);
      fillDateTime('b-cut', record.salesCutoffAt, record.salesCutoffAt);

      const metaMarkets = record.bMarkets || {};
      const line = metaMarkets.handicap?.line ?? record.regularHc ?? record.euroHc;
      const lineNumber = String(line ?? '').match(/[-+]?\d+/);
      setValue('b-line', lineNumber ? lineNumber[0] : '');
      const spf = sectionFromMeta(metaMarkets.spf);
      const handicap = sectionFromMeta(metaMarkets.handicap);
      const totals = sectionFromMeta(metaMarkets.totals);
      const score = sectionFromMeta(metaMarkets.score);
      const halfFull = sectionFromMeta(metaMarkets.halfFull);
      setValue('b-spf', record.spfRaw || (spf ? spfRaw(spf) : ''));
      setValue('b-handicap', record.handicapRaw || (handicap ? spfRaw(handicap) : ''));
      setValue('b-totals', record.goalsRaw || (totals ? totalsRaw(totals) : ''));
      setValue('b-score', record.scoreRaw || (score ? scoreRaw(score) : ''));
      setValue('b-hf', record.hfRaw || (halfFull ? hfRaw(halfFull) : ''));
      document.querySelectorAll('.b-check-result').forEach((el) => {
        el.textContent = '';
        el.className = 'b-check-result';
      });
    }
    return original.call(this, id);
  };
  wrapped.__bWrapped = true;
  window.backfillRecord = wrapped;
}

function installSaveBridge() {
  const original = window.saveRecord;
  if (typeof original !== 'function' || original.__bWrapped) return;
  const wrapped = function (...args) {
    const hasBoth = Boolean(state.sections?.spf && state.sections?.handicap);
    const saveOnce = (panType) => {
      const hidden = document.getElementById('panType');
      if (hidden) hidden.value = panType;
      if (typeof window.setPanType === 'function') window.setPanType(panType);
      const before = new Set(window.__bApp.getRecords().map((record) => record.id));
      const result = original.apply(this, args);
      const added = window.__bApp.getRecords().find((record) => !before.has(record.id));
      if (added && state.meta) {
        const meta = { ...state.meta, bMarkets: { ...(state.meta.bMarkets || {}) } };
        if (panType === 'normal') delete meta.bMarkets.handicap;
        else delete meta.bMarkets.spf;
        Object.assign(added, meta);
        added.panType = panType;
        if (!added.matchHalfScore) added.matchHalfScore = '';
        if (panType === 'normal') {
          added.regularHc = '';
          added.euroHc = '';
          added.hcOdds = { w: '', d: '', l: '' };
          added.hcResult = '';
          added.handicap = null;
        }
        window.__bApp.persist();
      }
      return { result, added };
    };

    if (!hasBoth) {
      const { result } = saveOnce(document.getElementById('panType')?.value || 'normal');
      renderUnresulted();
      return result;
    }

    const normalSave = saveOnce('normal');
    const handicapSave = saveOnce('handicap');
    const pairId = `pair-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    for (const item of [normalSave.added, handicapSave.added]) {
      if (item) item.bPairId = pairId;
    }
    window.__bApp.persist();
    renderUnresulted();
    return handicapSave.result;
  };
  wrapped.__bWrapped = true;
  window.saveRecord = wrapped;
}

function installFilterTools() {
  const card = document.querySelector('#tab-history .card');
  if (!card) return;
  const rows = [...card.querySelectorAll('.filter-row')];
  if (rows.length < 3) return;
  const advanced = rows[2];
  advanced.classList.add('b-filter-advanced');
  advanced.hidden = true;
  for (const id of ['filterTeams', 'filterKickoff', 'filterPan']) {
    const el = document.getElementById(id);
    if (el) advanced.append(el);
  }

  const actions = card.querySelector('.flex');
  if (!actions) return;
  const tools = document.createElement('div');
  tools.className = 'b-filter-tools';
  tools.innerHTML = `
    <button class="btn btn-secondary" type="button" id="b-more-filters">更多筛选（对阵 / 让球）</button>
    <button class="btn btn-secondary" type="button" id="b-reset-filters">重置筛选</button>`;
  actions.parentNode.insertBefore(tools, actions);

  const more = tools.querySelector('#b-more-filters');
  more.addEventListener('click', () => {
    advanced.hidden = !advanced.hidden;
    more.textContent = advanced.hidden ? '更多筛选（对阵 / 让球）' : '收起更多筛选';
  });
  tools.querySelector('#b-reset-filters').addEventListener('click', () => {
    for (const id of ['filterResult', 'filterLeague', 'filterTeams', 'filterSearch', 'filterKickoff', 'filterPan', 'filterRegularHc', 'filterEuroHc']) {
      const el = document.getElementById(id);
      if (el) el.value = '';
    }
    window.renderHistory?.();
  });
}

function installResultModal() {
  const modal = document.querySelector('#resultModal .card');
  if (!modal) return;
  modal.innerHTML = `
    <div class="card-title">录入赛果</div>
    <p class="tip" style="margin-bottom:8px">只填 90 分钟比分；半场可选。旧版历史/AI 会使用全场总进球。</p>
    <div class="b-grid">
      <div><label>全场比分</label><input id="b-result-full" placeholder="例如：2-1"></div>
      <div><label>半场比分（可选）</label><input id="b-result-half" placeholder="例如：0-1"></div>
    </div>
    <div class="flex" style="margin-top:10px">
      <button class="btn btn-secondary" onclick="closeModal()" style="flex:1">取消</button>
      <button class="btn btn-primary" id="b-result-save" style="flex:1">保存赛果</button>
    </div>`;

  const originalOpen = window.openResultModal;
  if (typeof originalOpen === 'function') {
    window.openResultModal = function (...args) {
      const result = originalOpen.apply(this, args);
      const record = window.__bApp.getRecords().find((item) => item.id === window.__bApp.getEditingId());
      if (record) {
        const full = String(record.matchScore || '').replace(':', '-');
        const half = String(record.matchHalfScore || '').replace(':', '-');
        document.getElementById('b-result-full').value = full;
        document.getElementById('b-result-half').value = half;
      }
      return result;
    };
  }

  // 旧版历史行用 inputScore(id) 打开单场赛果；改成新版全场/半场弹窗
  window.inputScore = function (id) {
    const record = window.__bApp.getRecords().find((item) => item.id === id);
    if (!record) return;
    window.__bApp.setEditingId(id);
    window.openResultModal();
  };

  // 旧版“胜/平/负”快捷按钮仍可用，但同步刷新未录入列表
  const originalSetMatchResult = window.setMatchResult;
  if (typeof originalSetMatchResult === 'function') {
    window.setMatchResult = function (...args) {
      const result = originalSetMatchResult.apply(this, args);
      renderUnresulted();
      return result;
    };
  }

  document.getElementById('b-result-save').addEventListener('click', () => {
    const record = window.__bApp.getRecords().find((item) => item.id === window.__bApp.getEditingId());
    if (!record) return;
    const full = document.getElementById('b-result-full').value.trim().match(/(\d+)\s*[-:：]\s*(\d+)/);
    if (!full) { alert('全场比分格式应为 2-1'); return; }
    const half = document.getElementById('b-result-half').value.trim().match(/(\d+)\s*[-:：]\s*(\d+)/);
    const h = Number(full[1]);
    const a = Number(full[2]);
    const applyScore = (target) => {
      target.matchScore = `${h}:${a}`;
      target.matchHalfScore = half ? `${half[1]}:${half[2]}` : '';
      const hcText = target.panType === 'handicap' ? (target.regularHc || target.euroHc || '') : '';
      const judged = typeof window.judgeFromScore === 'function'
        ? window.judgeFromScore(target.matchScore, hcText)
        : null;
      target.matchResult = judged?.result || (h > a ? 'h' : h === a ? 'd' : 'a');
      target.hcResult = target.panType === 'handicap' && hcText
        ? (judged?.hcResult || '')
        : '';
    };
    applyScore(record);
    if (record.bPairId) {
      window.__bApp.getRecords()
        .filter((item) => item.id !== record.id && item.bPairId === record.bPairId)
        .forEach(applyScore);
    }
    window.__bApp.persist();
    window.renderHistory?.();
    renderUnresulted();
    window.closeModal?.();
  });
}

function boot() {
  const tab = document.getElementById('tab-input');
  if (!tab || document.getElementById('b-entry')) return;
  [...tab.children].forEach((child) => { child.style.display = 'none'; });
  const panel = document.createElement('div');
  panel.id = 'b-entry';
  panel.innerHTML = panelHtml();
  tab.append(panel);
  document.getElementById('b-run').addEventListener('click', run);
  document.getElementById('b-clear').addEventListener('click', clearInputs);
  document.querySelectorAll('.b-check').forEach((button) => {
    button.addEventListener('click', () => checkCard(button.dataset.type));
  });
  for (const def of MARKET_DEFS) {
    document.getElementById(`b-${def.type}`)?.addEventListener('input', () => {
      const check = document.getElementById(`b-check-${def.type}`);
      if (check) {
        check.textContent = '';
        check.className = 'b-check-result';
      }
    });
  }
  bindDtInputs('b-kick');
  bindDtInputs('b-cut');
  installFilterTools();
  installSaveBridge();
  installResultModal();
  installUnresultedTab();
  installBackfillBridge();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
