import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import './App.css';

const DashboardLayout = lazy(() => import('./layouts/DashboardLayout'));
const Dashboard = lazy(() => import('./pages/dashboard/Dashboard'));
const OrdersPage = lazy(() => import('./pages/dashboard/OrdersPage'));
const InvoicesPage = lazy(() => import('./pages/dashboard/InvoicesPage'));
const InvoiceDetailPage = lazy(() => import('./pages/dashboard/InvoiceDetailPage'));
const TicketsPage = lazy(() => import('./pages/dashboard/TicketsPage'));
const Login = lazy(() => import('./pages/Login'));
const SupplierPage = lazy(() => import('./pages/dashboard/SupplierPage'));
const RatesPage = lazy(() => import('./pages/dashboard/RatesPage'));
const ProductPage = lazy(() => import('./pages/dashboard/ProductPage'));
const VerificationDesk = lazy(() => import('./pages/dashboard/VerificationDesk'));
const DriversPage = lazy(() => import('./pages/drivers/DriversPage'));
const DispatchBoard = lazy(() => import('./pages/dispatch/DispatchBoard'));
const DeliveriesPage = lazy(() => import('./pages/deliveries/DeliveriesPage'));
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
