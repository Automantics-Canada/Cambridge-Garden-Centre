import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import LandingPage from './pages/LandingPage';
import DashboardLayout from './layouts/DashboardLayout';
import Dashboard from './pages/dashboard/Dashboard';
import OrdersPage from './pages/dashboard/OrdersPage';
import InvoicesPage from './pages/dashboard/InvoicesPage';
import TicketsPage from './pages/dashboard/TicketsPage';
import Login from './pages/Login';
import Register from './pages/Register';
import './App.css';
import SupplierPage from './pages/dashboard/SupplierPage';

const ProtectedRoute = ({ children }) => {
  const isAuthenticated = useSelector((state) => state.auth.isAuthenticated);
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return children;
};

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        
        <Route path="/dashboard" element={
          <ProtectedRoute>
            <DashboardLayout />
          </ProtectedRoute>
        }>
          <Route index element={<Dashboard />} />
          <Route path="orders" element={<OrdersPage />} />
          <Route path="invoices" element={<InvoicesPage />} />
          <Route path="tickets" element={<TicketsPage />} />
          <Route path="supplier" element={<SupplierPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
