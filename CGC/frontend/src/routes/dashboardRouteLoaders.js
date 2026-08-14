export const dashboardRouteLoaders = {
  dashboard: () => import('../pages/dashboard/Dashboard'),
  orders: () => import('../pages/dashboard/OrdersPage'),
  invoices: () => import('../pages/dashboard/InvoicesPage'),
  invoiceDetail: () => import('../pages/dashboard/InvoiceDetailPage'),
  tickets: () => import('../pages/dashboard/TicketsPage'),
  supplier: () => import('../pages/dashboard/SupplierPage'),
  rates: () => import('../pages/dashboard/RatesPage'),
  products: () => import('../pages/dashboard/ProductPage'),
  verificationDesk: () => import('../pages/dashboard/VerificationDesk'),
  drivers: () => import('../pages/drivers/DriversPage'),
  dispatch: () => import('../pages/dispatch/DispatchBoard'),
  deliveries: () => import('../pages/deliveries/DeliveriesPage'),
};

const loadersByPath = {
  '/dashboard': [dashboardRouteLoaders.dashboard],
  '/dashboard/orders': [dashboardRouteLoaders.orders],
  '/dashboard/invoices': [
    dashboardRouteLoaders.invoices,
    dashboardRouteLoaders.invoiceDetail,
  ],
  '/dashboard/tickets': [dashboardRouteLoaders.tickets],
  '/dashboard/supplier': [dashboardRouteLoaders.supplier],
  '/dashboard/rates': [dashboardRouteLoaders.rates],
  '/dashboard/products': [dashboardRouteLoaders.products],
  '/dashboard/verification-desk': [dashboardRouteLoaders.verificationDesk],
  '/dashboard/drivers': [dashboardRouteLoaders.drivers],
  '/dashboard/dispatch': [dashboardRouteLoaders.dispatch],
  '/dashboard/deliveries': [dashboardRouteLoaders.deliveries],
};

export function preloadDashboardRoute(path) {
  return Promise.allSettled((loadersByPath[path] || []).map(loader => loader()));
}

export function preloadAllDashboardRoutes() {
  return Promise.allSettled(
    [...new Set(Object.values(dashboardRouteLoaders))].map(loader => loader()),
  );
}
