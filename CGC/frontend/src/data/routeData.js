import api from '../api/axios';
import { loadRouteData, readRouteDataCache, readStaleRouteDataCache } from '../lib/routeDataCache';

/**
 * One canonical authenticated read path per resource.
 *
 * The previous revision raced the Express API against the Supabase Edge
 * function (and, on the Dashboard, against the legacy full-ledger endpoint),
 * taking whichever resolved first. Measured in production that turned three
 * pieces of data on the tickets screen into seven requests, and every dashboard
 * visit into two full invoice-ledger downloads. A race also cannot make a
 * missing route appear: the losing branches were failing deployments, not
 * healthy alternatives, so the fan-out bought latency and database load and
 * nothing else.
 *
 * Each read below therefore has exactly one source. When it fails, it fails
 * visibly — see `RouteDataError` — instead of being masked by a slower branch.
 */

const DASHBOARD_KEY = 'dashboard';
const TICKET_STATS_KEY = 'ticket-stats';
const SUPPLIER_OPTIONS_KEY = 'supplier-options';
const DEFAULT_TICKET_QUERY = { page: 1, limit: 25 };
const DEFAULT_INVOICE_QUERY = { page: 1, limit: 25 };

/** Carries the failing resource so a screen can name it in an error banner. */
export class RouteDataError extends Error {
  constructor(resource, cause) {
    const status = cause?.response?.status;
    super(
      status
        ? `Could not load ${resource} (server returned ${status}).`
        : `Could not load ${resource}. The server did not respond.`,
    );
    this.name = 'RouteDataError';
    this.resource = resource;
    this.status = status;
    this.cause = cause;
  }
}

async function get(resource, url, config) {
  try {
    const response = await api.get(url, config);
    return response.data;
  } catch (error) {
    throw new RouteDataError(resource, error);
  }
}

/** Drops empty values so they never become `?status=` and widen a query. */
function toParams(query) {
  const params = {};
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '' && value !== false) {
      params[key] = value;
    }
  });
  return params;
}

function cacheKey(prefix, query) {
  const params = new URLSearchParams(
    Object.entries(toParams(query)).map(([k, v]) => [k, String(v)]),
  );
  params.sort();
  return `${prefix}:${params.toString()}`;
}

function assertDashboardPayload(data) {
  if (!data || !Array.isArray(data.recentInvoices) || !data.stats) {
    throw new Error('Invalid dashboard summary response');
  }
  return data;
}

function normalizePage(data, resource) {
  if (!data || !Array.isArray(data.data)) {
    throw new RouteDataError(resource, null);
  }
  return {
    data: data.data,
    pagination: {
      page: data.pagination?.page || 1,
      limit: data.pagination?.limit || data.data.length,
      totalPages: data.pagination?.totalPages || 1,
      totalCount: data.pagination?.totalCount ?? data.data.length,
    },
  };
}

/* -------------------------------------------------------------- dashboard */

async function requestDashboard() {
  const data = await get('the dashboard', '/api/invoices/dashboard-summary', { timeout: 15_000 });
  return assertDashboardPayload(data);
}

export function getCachedDashboardData(userId) {
  return readStaleRouteDataCache(userId, DASHBOARD_KEY);
}

export function loadDashboardData(userId, options) {
  return loadRouteData(userId, DASHBOARD_KEY, requestDashboard, options);
}

/* --------------------------------------------------------------- invoices */

async function requestInvoicePage(query) {
  const data = await get('invoices', '/api/invoices', {
    params: toParams(query),
    timeout: 15_000,
  });
  // Keep the Vercel/Railway rollout order harmless. The backend returned a
  // bare array before server-side pagination landed, so a frontend deployment
  // that wins the race must remain usable until Railway finishes. This branch
  // disappears naturally once the paginated backend is live.
  if (Array.isArray(data)) {
    return {
      data,
      pagination: { page: 1, limit: data.length, totalPages: 1, totalCount: data.length },
    };
  }
  return normalizePage(data, 'invoices');
}

export function getCachedInvoicePage(userId, query = DEFAULT_INVOICE_QUERY) {
  return readStaleRouteDataCache(userId, cacheKey('invoices', query));
}

export function loadInvoicePage(userId, query = DEFAULT_INVOICE_QUERY, options) {
  return loadRouteData(
    userId,
    cacheKey('invoices', query),
    () => requestInvoicePage(query),
    options,
  );
}

/* ---------------------------------------------------------------- tickets */

async function requestTicketPage(query) {
  const data = await get('tickets', '/api/tickets', {
    params: toParams(query),
    timeout: 15_000,
  });
  // The tickets endpoint returned a bare array before it was paginated.
  if (Array.isArray(data)) {
    return {
      data,
      pagination: { page: 1, limit: data.length, totalPages: 1, totalCount: data.length },
    };
  }
  return normalizePage(data, 'tickets');
}

export function getCachedTicketPage(userId, query = DEFAULT_TICKET_QUERY) {
  return readStaleRouteDataCache(userId, cacheKey('tickets', query));
}

export function loadTicketPage(userId, query = DEFAULT_TICKET_QUERY, options) {
  return loadRouteData(
    userId,
    cacheKey('tickets', query),
    () => requestTicketPage(query),
    options,
  );
}

async function requestTicketStats() {
  const data = await get('ticket counts', '/api/tickets/stats', { timeout: 10_000 });
  return {
    unlinkedCount: data?.unlinkedCount || 0,
    stuckDocumentCount: data?.stuckDocumentCount || 0,
  };
}

export function getCachedTicketStats(userId) {
  return readStaleRouteDataCache(userId, TICKET_STATS_KEY);
}

export function loadTicketStats(userId, options) {
  return loadRouteData(userId, TICKET_STATS_KEY, requestTicketStats, options);
}

/* -------------------------------------------------------------- suppliers */

async function requestSupplierOptions() {
  const data = await get('the supplier list', '/api/suppliers/options', { timeout: 10_000 });
  const suppliers = Array.isArray(data) ? data : data?.data;
  if (!Array.isArray(suppliers)) throw new RouteDataError('the supplier list', null);
  return suppliers.map(({ id, name }) => ({ id, name }));
}

export function getCachedSupplierOptions(userId) {
  return readStaleRouteDataCache(userId, SUPPLIER_OPTIONS_KEY);
}

export function loadSupplierOptions(userId, options) {
  // Dropdown contents change rarely; a longer TTL keeps filter bars instant.
  return loadRouteData(userId, SUPPLIER_OPTIONS_KEY, requestSupplierOptions, {
    ttlMs: 10 * 60 * 1000,
    ...options,
  });
}

/* --------------------------------------------------------------- preload  */

export function preloadRouteData(path, userId) {
  if (!userId) return;
  if (path === '/dashboard') {
    void loadDashboardData(userId).catch(() => {});
  }
  if (path === '/dashboard/tickets') {
    void loadTicketPage(userId, DEFAULT_TICKET_QUERY).catch(() => {});
    void loadSupplierOptions(userId).catch(() => {});
  }
  if (path === '/dashboard/verification-desk' || path === '/dashboard/invoices') {
    void loadInvoicePage(userId, DEFAULT_INVOICE_QUERY).catch(() => {});
  }
}

export { DEFAULT_TICKET_QUERY, DEFAULT_INVOICE_QUERY, readRouteDataCache };
