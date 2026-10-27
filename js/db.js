import {
  APP_ID,
  SCHEMA_VERSION,
  createId,
  normalizeMatch,
  nowIso
} from './schema.js';
import { mergeSnapshots } from './parse.js';

const DB_NAME = 'jingcai-lab';
const DB_VERSION = 1;
let dbPromise = null;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('事务已取消'));
  });
}

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('matches')) {
        const store = db.createObjectStore('matches', { keyPath: 'matchId' });
        store.createIndex('kickoff', 'kickoff');
        store.createIndex('status', 'status');
        store.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

export async function listMatches({ includeDeleted = false } = {}) {
  const db = await openDB();
  const transaction = db.transaction('matches', 'readonly');
  const all = await requestToPromise(transaction.objectStore('matches').getAll());
  const matches = all
    .filter((match) => includeDeleted || !match.deletedAt)
    .sort((a, b) => {
      const at = Date.parse(a.kickoff) || 0;
      const bt = Date.parse(b.kickoff) || 0;
      return bt - at;
    });
  return matches;
}

export async function getMatch(matchId) {
  const db = await openDB();
  const transaction = db.transaction('matches', 'readonly');
  return requestToPromise(transaction.objectStore('matches').get(matchId));
}

export async function putMatch(match) {
  const normalized = normalizeMatch(match);
  normalized.updatedAt = nowIso();
  const db = await openDB();
  const transaction = db.transaction('matches', 'readwrite');
  transaction.objectStore('matches').put(normalized);
  await transactionDone(transaction);
  return normalized;
}

export async function softDeleteMatch(matchId) {
  const match = await getMatch(matchId);
  if (!match) return null;
  const at = nowIso();
  return putMatch({
    ...match,
    deletedAt: at,
    audit: [...(match.audit || []), { at, action: 'delete', detail: '删除比赛（软删除）' }]
  });
}

export async function restoreMatch(matchId) {
  const match = await getMatch(matchId);
  if (!match) return null;
  const at = nowIso();
  return putMatch({
    ...match,
    deletedAt: null,
    audit: [...(match.audit || []), { at, action: 'restore', detail: '恢复比赛' }]
  });
}

export async function clearMatches() {
  const db = await openDB();
  const transaction = db.transaction('matches', 'readwrite');
  transaction.objectStore('matches').clear();
  await transactionDone(transaction);
}

export async function getSetting(key, fallback = null) {
  const db = await openDB();
  const transaction = db.transaction('settings', 'readonly');
  const record = await requestToPromise(transaction.objectStore('settings').get(key));
  return record ? record.value : fallback;
}

export async function setSetting(key, value) {
  const db = await openDB();
  const transaction = db.transaction('settings', 'readwrite');
  transaction.objectStore('settings').put({ key, value });
  await transactionDone(transaction);
}

export function countStats(matches = []) {
  const active = matches.filter((match) => !match.deletedAt);
  const pending = active.filter((match) => match.status === 'scheduled');
  const settled = active.filter((match) => match.status === 'finished');
  const snapshots = active.reduce((sum, match) => (
    sum + (match.markets || []).reduce((inner, market) => inner + (market.snapshots?.length || 0), 0)
  ), 0);
  return {
    matches: active.length,
    pending: pending.length,
    settled: settled.length,
    snapshots,
    markets: active.reduce((sum, match) => sum + (match.markets?.length || 0), 0)
  };
}

export async function exportSnapshot() {
  const matches = await listMatches();
  const counts = countStats(matches);
  return {
    app: APP_ID,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: nowIso(),
    counts,
    matches
  };
}

function dedupeAudit(audit = []) {
  const seen = new Set();
  return audit.filter((item) => {
    if (!item) return false;
    const key = `${item.at || ''}|${item.action || ''}|${item.detail || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeMatch(local, incoming) {
  const localAt = Date.parse(local.updatedAt) || 0;
  const incomingAt = Date.parse(incoming.updatedAt) || 0;
  const newer = incomingAt >= localAt ? incoming : local;
  const older = incomingAt >= localAt ? local : incoming;

  const marketMap = new Map();
  for (const market of [...(older.markets || []), ...(newer.markets || [])]) {
    const key = `${market.type}|${market.line ?? ''}`;
    if (!marketMap.has(key)) {
      marketMap.set(key, market);
      continue;
    }
    const current = marketMap.get(key);
    const preferred = Date.parse(market.settledAt || 0) >= Date.parse(current.settledAt || 0)
      ? market
      : current;
    marketMap.set(key, {
      ...preferred,
      snapshots: mergeSnapshots(current.snapshots || [], market.snapshots || [])
    });
  }

  return {
    ...newer,
    createdAt: [local.createdAt, incoming.createdAt].filter(Boolean).sort()[0] || newer.createdAt,
    markets: [...marketMap.values()],
    audit: dedupeAudit([...(older.audit || []), ...(newer.audit || [])])
      .sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0)),
    updatedAt: newer.updatedAt || nowIso()
  };
}

/**
 * 合并导入。默认 merge：同 matchId 取较新的赛果，市场按 type+line 合并快照。
 * replace 会先清空本地比赛，适合“恢复备份”。
 */
export async function importSnapshot(payload, { mode = 'merge' } = {}) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.matches)) {
    throw new Error('不是有效的 jingcai-lab JSON：缺少 matches 数组');
  }
  const version = Number(payload.schemaVersion || 1);
  if (version > SCHEMA_VERSION) {
    throw new Error(`备份版本 ${version} 高于当前应用支持的 ${SCHEMA_VERSION}`);
  }

  const normalized = [];
  const errors = [];
  payload.matches.forEach((item, index) => {
    try {
      normalized.push(normalizeMatch(item));
    } catch (error) {
      errors.push(`第 ${index + 1} 条：${error.message}`);
    }
  });

  if (mode === 'replace') {
    await clearMatches();
  }

  const existing = await listMatches({ includeDeleted: true });
  const existingMap = new Map(existing.map((match) => [match.matchId, match]));
  const db = await openDB();
  const transaction = db.transaction('matches', 'readwrite');
  const store = transaction.objectStore('matches');

  let imported = 0;
  let merged = 0;
  let skipped = 0;

  for (const match of normalized) {
    const local = existingMap.get(match.matchId);
    if (!local) {
      store.put(match);
      imported += 1;
      continue;
    }
    const localAt = Date.parse(local.updatedAt) || 0;
    const incomingAt = Date.parse(match.updatedAt) || 0;
    if (incomingAt === localAt) {
      const same = JSON.stringify(local) === JSON.stringify(match);
      if (same) {
        skipped += 1;
      } else {
        store.put(mergeMatch(local, match));
        merged += 1;
      }
    } else {
      store.put(mergeMatch(local, match));
      merged += 1;
    }
  }

  await transactionDone(transaction);
  return { imported, merged, skipped, errors, total: normalized.length };
}

export async function setLastExportAt() {
  await setSetting('lastExportAt', nowIso());
}

export function newMatchId() {
  return createId('m');
}
