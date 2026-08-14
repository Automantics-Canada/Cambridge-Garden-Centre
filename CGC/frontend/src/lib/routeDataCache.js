const CACHE_PREFIX = 'cgc-route-data-v1';
const DEFAULT_TTL_MS = 5 * 60 * 1000;

const memoryCache = new Map();
const inFlightRequests = new Map();
const cacheGenerations = new Map();

function storageKey(userId, key) {
  return `${CACHE_PREFIX}:${userId || 'unknown'}:${key}`;
}

function readEntry(key) {
  const memoryEntry = memoryCache.get(key);
  if (memoryEntry) return memoryEntry;

  if (typeof window === 'undefined') return null;
  try {
    const stored = window.sessionStorage.getItem(key);
    if (!stored) return null;
    const entry = JSON.parse(stored);
    memoryCache.set(key, entry);
    return entry;
  } catch {
    return null;
  }
}

export function readRouteDataCache(userId, key) {
  const keyWithScope = storageKey(userId, key);
  const entry = readEntry(keyWithScope);
  if (!entry) return null;
  if (!entry.expiresAt || entry.expiresAt <= Date.now()) {
    memoryCache.delete(keyWithScope);
    if (typeof window !== 'undefined') {
      window.sessionStorage.removeItem(keyWithScope);
    }
    return null;
  }
  return entry.data;
}

export function writeRouteDataCache(userId, key, data, ttlMs = DEFAULT_TTL_MS) {
  const keyWithScope = storageKey(userId, key);
  const entry = { data, expiresAt: Date.now() + ttlMs };
  memoryCache.set(keyWithScope, entry);
  if (typeof window !== 'undefined') {
    try {
      window.sessionStorage.setItem(keyWithScope, JSON.stringify(entry));
    } catch {
      // A full/disabled session store must not make the route fail.
    }
  }
  return data;
}

export function loadRouteData(userId, key, loader, { force = false, ttlMs } = {}) {
  const keyWithScope = storageKey(userId, key);
  const userScope = userId || 'unknown';
  if (!force) {
    const cached = readRouteDataCache(userId, key);
    if (cached !== null) return Promise.resolve(cached);
  }

  const existing = inFlightRequests.get(keyWithScope);
  if (existing) return existing;

  const generation = cacheGenerations.get(userScope) || 0;
  const request = Promise.resolve()
    .then(loader)
    .then((data) => {
      if ((cacheGenerations.get(userScope) || 0) !== generation) return data;
      return writeRouteDataCache(userId, key, data, ttlMs);
    })
    .finally(() => inFlightRequests.delete(keyWithScope));
  inFlightRequests.set(keyWithScope, request);
  return request;
}

export function clearRouteDataCache(userId) {
  const userScope = userId || 'unknown';
  const prefix = `${CACHE_PREFIX}:${userScope}:`;
  cacheGenerations.set(userScope, (cacheGenerations.get(userScope) || 0) + 1);
  for (const key of memoryCache.keys()) {
    if (key.startsWith(prefix)) memoryCache.delete(key);
  }
  for (const key of inFlightRequests.keys()) {
    if (key.startsWith(prefix)) inFlightRequests.delete(key);
  }

  if (typeof window === 'undefined') return;
  const keys = [];
  for (let index = 0; index < window.sessionStorage.length; index += 1) {
    const key = window.sessionStorage.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  keys.forEach((key) => window.sessionStorage.removeItem(key));
}
