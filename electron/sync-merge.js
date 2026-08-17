const MERGE_ARRAY_KEYS = [
  { key: 'notion_app_tasks', collection: 'tasks', getKey: (item) => String(item?.id ?? '') },
  { key: 'notion_app_anniversaries', collection: 'anniversaries', getKey: (item) => String(item?.id ?? '') },
  { key: 'notion_app_ann_categories', collection: 'ann_categories', getKey: (item) => String(item?.id ?? '') }
];

const MERGE_CATEGORY_KEY = 'notion_app_categories';

const SCALAR_KEYS = [
  'notion_app_theme',
  'notion_app_show_lunar',
  'notion_app_plan_reset_hour',
  'notion_app_distant_schedule_days',
  'notion_app_completed_hold_days',
  'notion_app_hub_categories'
];

function parseArray(raw) {
  if (raw == null || raw === '') return [];
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function itemVersion(item) {
  if (!item || typeof item !== 'object') return 0;
  const modifiedAt = Number(item.modifiedAt);
  if (Number.isFinite(modifiedAt) && modifiedAt > 0) return modifiedAt;
  const completedAt = Number(item.completedAt);
  if (Number.isFinite(completedAt) && completedAt > 0) return completedAt;
  const id = item.id;
  if (typeof id === 'number' && Number.isFinite(id) && id > 0) return id;
  if (typeof id === 'string') {
    const parsed = Number(id.startsWith('ann_') ? id.slice(4) : id);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function deletionTime(deletions, id) {
  const raw = deletions?.[String(id)];
  if (!raw) return 0;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeOrderedRecords(localArr, remoteArr, deletions, getKey, preferLocal, remoteNewer) {
  const useLocalOrder = preferLocal && !remoteNewer;
  const primary = useLocalOrder ? localArr : remoteArr;
  const secondary = useLocalOrder ? remoteArr : localArr;
  const byKey = new Map();

  for (const item of remoteArr) {
    const key = getKey(item);
    if (!key || deletionTime(deletions, key)) continue;
    const existing = byKey.get(key);
    if (!existing || itemVersion(item) > itemVersion(existing)) {
      byKey.set(key, item);
    }
  }

  for (const item of localArr) {
    const key = getKey(item);
    if (!key || deletionTime(deletions, key)) continue;
    const existing = byKey.get(key);
    const localVersion = itemVersion(item);
    const existingVersion = existing ? itemVersion(existing) : -1;
    if (!existing || localVersion > existingVersion
      || (preferLocal && localVersion === existingVersion)) {
      byKey.set(key, item);
    }
  }

  const merged = [];
  const seen = new Set();

  for (const item of primary) {
    const key = getKey(item);
    if (!key || deletionTime(deletions, key)) continue;
    const chosen = byKey.get(key);
    if (chosen) {
      merged.push(chosen);
      seen.add(key);
    }
  }

  for (const item of secondary) {
    const key = getKey(item);
    if (!key || seen.has(key) || deletionTime(deletions, key)) continue;
    const chosen = byKey.get(key);
    if (chosen) {
      merged.push(chosen);
      seen.add(key);
    }
  }

  return merged;
}

function mergeCategories(localArr, remoteArr, deletions, preferLocal, remoteNewer) {
  return mergeOrderedRecords(
    localArr,
    remoteArr,
    deletions,
    (item) => item?.name || '',
    preferLocal,
    remoteNewer
  );
}

function mergeDeletions(localDeletions = {}, remoteDeletions = {}) {
  const merged = {};
  const collections = new Set([
    ...Object.keys(localDeletions || {}),
    ...Object.keys(remoteDeletions || {})
  ]);

  for (const collection of collections) {
    const localMap = localDeletions?.[collection] || {};
    const remoteMap = remoteDeletions?.[collection] || {};
    const next = { ...remoteMap };
    Object.entries(localMap).forEach(([id, at]) => {
      if (!next[id] || Date.parse(at) > Date.parse(next[id])) {
        next[id] = at;
      }
    });
    if (Object.keys(next).length) merged[collection] = next;
  }

  return merged;
}

function pickScalar(localVal, remoteVal, preferLocal, remoteNewer) {
  if (preferLocal && !remoteNewer && localVal !== undefined) return localVal;
  if (remoteVal !== undefined) return remoteVal;
  return localVal;
}

function normalizeData(data = {}) {
  const normalized = {};
  Object.entries(data).forEach(([key, value]) => {
    if (value !== undefined) normalized[key] = value;
  });
  return normalized;
}

function deletionsEqual(a = {}, b = {}) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function dataEquals(a = {}, b = {}) {
  const left = normalizeData(a);
  const right = normalizeData(b);
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

function payloadEquals(payload, remote) {
  if (!remote) return false;
  return dataEquals(payload?.data || {}, remote?.data || {})
    && deletionsEqual(payload?.deletions || {}, remote?.deletions || {});
}

function mergeSyncPayloads({
  localData = {},
  remoteData = {},
  localDeletions = {},
  remoteDeletions = {},
  localEditedAt = null,
  remoteUpdatedAt = null
}) {
  const preferLocal = !!localEditedAt;
  const remoteUpdated = remoteUpdatedAt ? Date.parse(remoteUpdatedAt) : 0;
  const localEdited = localEditedAt ? Date.parse(localEditedAt) : 0;
  const remoteNewer = remoteUpdated > localEdited;
  const deletions = mergeDeletions(localDeletions, remoteDeletions);

  const data = {};

  MERGE_ARRAY_KEYS.forEach(({ key, collection, getKey }) => {
    const mergedArr = mergeOrderedRecords(
      parseArray(localData[key]),
      parseArray(remoteData[key]),
      deletions[collection] || {},
      getKey,
      preferLocal,
      remoteNewer
    );
    if (mergedArr.length || localData[key] !== undefined || remoteData[key] !== undefined) {
      data[key] = JSON.stringify(mergedArr);
    }
  });

  const mergedCategories = mergeCategories(
    parseArray(localData[MERGE_CATEGORY_KEY]),
    parseArray(remoteData[MERGE_CATEGORY_KEY]),
    deletions.categories || {},
    preferLocal,
    remoteNewer
  );
  if (mergedCategories.length || localData[MERGE_CATEGORY_KEY] !== undefined || remoteData[MERGE_CATEGORY_KEY] !== undefined) {
    data[MERGE_CATEGORY_KEY] = JSON.stringify(mergedCategories);
  }

  SCALAR_KEYS.forEach((key) => {
    const value = pickScalar(localData[key], remoteData[key], preferLocal, remoteNewer);
    if (value !== undefined) data[key] = value;
  });

  return {
    data,
    deletions,
    updatedAt: new Date().toISOString()
  };
}

module.exports = {
  mergeSyncPayloads,
  dataEquals,
  payloadEquals,
  deletionsEqual,
  parseArray,
  mergeDeletions
};
