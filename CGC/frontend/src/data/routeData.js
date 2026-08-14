import api from '../api/axios';
import { supabase } from '../supabaseClient';
import { loadRouteData, readRouteDataCache } from '../lib/routeDataCache';

const DASHBOARD_KEY = 'dashboard';
const TICKET_STATS_KEY = 'ticket-stats';
const SUPPLIER_OPTIONS_KEY = 'supplier-options';
const DEFAULT_TICKET_QUERY = { page: 1, limit: 25 };

function tokenHeaders() {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function dashboardFromInvoices(invoices) {
  const safeInvoices = Array.isArray(invoices) ? invoices : [];
  const now = new Date();
  return {
    recentInvoices: safeInvoices.slice(0, 5),
    stats: {
      totalMonthly: safeInvoices.filter((invoice) => {
        const receivedAt = new Date(invoice.receivedAt);
        return receivedAt.getMonth() === now.getMonth()
          && receivedAt.getFullYear() === now.getFullYear();
      }).length,
      pendingCount: safeInvoices.filter((invoice) => invoice.status === 'PENDING_REVIEW').length,
      disputedCount: safeInvoices.filter((invoice) => invoice.status === 'DISPUTED').length,
      savingsDetected: 0,
    },
  };
}

function assertDashboardPayload(data) {
  if (!data || !Array.isArray(data.recentInvoices) || !data.stats) {
    throw new Error('Invalid dashboard summary response');
  }
  return data;
}

async function invokeEdge(params) {
  const { data, error } = await supabase.functions.invoke(
    `fetch-cgc-data?${params.toString()}`,
    { method: 'GET', headers: tokenHeaders() },
  );
  if (error) throw error;
  return data;
}

async function firstSuccessful(sources) {
  const result = await Promise.any(
    sources.map(async ([source, request]) => ({ source, data: await request })),
  );
  return result;
}

async function requestDashboard() {
  const controller = new AbortController();
  const fastBackend = api.get('/api/invoices/dashboard-summary', {
    signal: controller.signal,
    timeout: 8_000,
  }).then((response) => assertDashboardPayload(response.data));

  const edgeSummary = invokeEdge(new URLSearchParams({ resource: 'dashboard-summary' }))
    .then(assertDashboardPayload)
    .catch(async () => {
      // The Edge function is deployed separately. Older revisions still have
      // the bounded invoices resource even when dashboard-summary is missing.
      const fallback = await invokeEdge(new URLSearchParams({
        resource: 'invoices', page: '1', limit: '1000',
      }));
      return dashboardFromInvoices(fallback?.data || fallback);
    });

  const legacyBackend = api.get('/api/invoices', {
    signal: controller.signal,
    timeout: 20_000,
  }).then((response) => dashboardFromInvoices(response.data));

  const winner = await firstSuccessful([
    ['backend-summary', fastBackend],
    ['edge', edgeSummary],
    ['legacy-backend', legacyBackend],
  ]);
  if (winner.source === 'edge') controller.abort();
  return winner.data;
}

function ticketCacheKey(query) {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  });
  params.sort();
  return `tickets:${params.toString()}`;
}

function normalizeTicketPage(data) {
  if (Array.isArray(data)) {
    return { data, pagination: { page: 1, totalPages: 1, totalCount: data.length } };
  }
  if (!data || !Array.isArray(data.data)) throw new Error('Invalid tickets response');
  return {
    data: data.data,
    pagination: {
      page: data.pagination?.page || 1,
      totalPages: data.pagination?.totalPages || 1,
      totalCount: data.pagination?.totalCount ?? data.data.length,
    },
  };
}

async function requestTicketPage(query) {
  const controller = new AbortController();
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  });
  params.set('resource', 'tickets');

  const backend = api.get('/api/tickets', {
    params: query,
    signal: controller.signal,
    timeout: 15_000,
  }).then((response) => normalizeTicketPage(response.data));
  const edge = invokeEdge(params).then(normalizeTicketPage);

  const winner = await firstSuccessful([
    ['backend', backend],
    ['edge', edge],
  ]);
  if (winner.source === 'edge') controller.abort();
  return winner.data;
}

async function requestTicketStats() {
  const backend = api.get('/api/tickets/stats', { timeout: 10_000 })
    .then((response) => ({ unlinkedCount: response.data?.unlinkedCount || 0 }));
  const edge = invokeEdge(new URLSearchParams({
    resource: 'tickets', status: 'UNLINKED', page: '1', limit: '1',
  })).then((data) => ({
    unlinkedCount: data?.pagination?.totalCount ?? data?.data?.length ?? 0,
  }));
  return (await firstSuccessful([['backend', backend], ['edge', edge]])).data;
}

function supplierOptionsFrom(data) {
  const suppliers = Array.isArray(data) ? data : data?.data;
  if (!Array.isArray(suppliers)) throw new Error('Invalid suppliers response');
  return suppliers.map(({ id, name }) => ({ id, name }));
}

async function requestSupplierOptions() {
  const options = api.get('/api/suppliers/options', { timeout: 8_000 })
    .then((response) => supplierOptionsFrom(response.data));
  const legacy = api.get('/api/suppliers', { timeout: 12_000 })
    .then((response) => supplierOptionsFrom(response.data));
  const edge = invokeEdge(new URLSearchParams({
    resource: 'suppliers', page: '1', limit: '1000',
  })).then(supplierOptionsFrom);
  return (await firstSuccessful([
    ['options', options],
    ['legacy', legacy],
    ['edge', edge],
  ])).data;
}

export function getCachedDashboardData(userId) {
  return readRouteDataCache(userId, DASHBOARD_KEY);
}

export function loadDashboardData(userId, options) {
  return loadRouteData(userId, DASHBOARD_KEY, requestDashboard, options);
}

export function getCachedTicketPage(userId, query = DEFAULT_TICKET_QUERY) {
  return readRouteDataCache(userId, ticketCacheKey(query));
}

export function loadTicketPage(userId, query = DEFAULT_TICKET_QUERY, options) {
  return loadRouteData(userId, ticketCacheKey(query), () => requestTicketPage(query), options);
}

export function getCachedTicketStats(userId) {
  return readRouteDataCache(userId, TICKET_STATS_KEY);
}

export function loadTicketStats(userId, options) {
  return loadRouteData(userId, TICKET_STATS_KEY, requestTicketStats, options);
}

export function getCachedSupplierOptions(userId) {
  return readRouteDataCache(userId, SUPPLIER_OPTIONS_KEY);
}

export function loadSupplierOptions(userId, options) {
  return loadRouteData(userId, SUPPLIER_OPTIONS_KEY, requestSupplierOptions, options);
}

export function preloadRouteData(path, userId) {
  if (!userId) return;
  if (path === '/dashboard') {
    void loadDashboardData(userId).catch(() => {});
  }
  if (path === '/dashboard/tickets') {
    void loadTicketPage(userId, DEFAULT_TICKET_QUERY).catch(() => {});
  }
}
