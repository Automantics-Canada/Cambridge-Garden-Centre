import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { dashboardRouteLoaders } from './routes/dashboardRouteLoaders';
import './App.css';

const DashboardLayout = lazy(() => import('./layouts/DashboardLayout'));
const Dashboard = lazy(dashboardRouteLoaders.dashboard);
const OrdersPage = lazy(dashboardRouteLoaders.orders);
const InvoicesPage = lazy(dashboardRouteLoaders.invoices);
const InvoiceDetailPage = lazy(dashboardRouteLoaders.invoiceDetail);
const TicketsPage = lazy(dashboardRouteLoaders.tickets);
const Login = lazy(() => import('./pages/Login'));
const SupplierPage = lazy(dashboardRouteLoaders.supplier);
const RatesPage = lazy(dashboardRouteLoaders.rates);
const ProductPage = lazy(dashboardRouteLoaders.products);
const VerificationDesk = lazy(dashboardRouteLoaders.verificationDesk);
const DriversPage = lazy(dashboardRouteLoaders.drivers);
const DispatchBoard = lazy(dashboardRouteLoaders.dispatch);
const DeliveriesPage = lazy(dashboardRouteLoaders.deliveries);
const DriverMobileView = lazy(() => import('./pages/driver/DriverMobileView'));

const RouteFallback = () => (
  <div className="min-h-screen bg-canvas flex items-center justify-center text-sm font-semibold text-brand">
    Loading Cambridge Garden Centre…
  </div>
);

const ProtectedRoute = ({ children }) => {
  const { isAuthenticated, user } = useSelector((state) => state.auth);
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (user?.role === 'DRIVER') return <Navigate to="/driver/today" replace />;
  return children;
};

const DriverProtectedRoute = ({ children }) => {
  const { isAuthenticated } = useSelector((state) => state.auth);
  
  // Extract token from URL
  const queryParams = new URLSearchParams(window.location.search);
  const token = queryParams.get('token');

  // If there's a legacy URL token, bypass authentication check
  if (token) return children;

  // Otherwise, enforce authentication
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return children;
};

function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/login" element={<Login />} />
          <Route path="/login/driver" element={<Login />} />
        
        <Route path="/dashboard" element={
          <ProtectedRoute>
            <DashboardLayout />
          </ProtectedRoute>
        }>
          <Route index element={<Dashboard />} />
          <Route path="orders" element={<OrdersPage />} />
          <Route path="invoices" element={<InvoicesPage />} />
          <Route path="invoices/:id" element={<InvoiceDetailPage />} />
          <Route path="tickets" element={<TicketsPage />} />
          <Route path="supplier" element={<SupplierPage />} />
          <Route path="rates" element={<RatesPage />} />
          <Route path="products" element={<ProductPage />} />
          <Route path="verification-desk" element={<VerificationDesk />} />
          <Route path="drivers" element={<DriversPage />} />
          <Route path="dispatch" element={<DispatchBoard />} />
          <Route path="deliveries" element={<DeliveriesPage />} />
        </Route>
        
          <Route path="/driver/today" element={
            <DriverProtectedRoute>
              <DriverMobileView />
            </DriverProtectedRoute>
          } />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

export default App;
