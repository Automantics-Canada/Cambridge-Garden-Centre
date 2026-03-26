import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import LandingPage from './pages/LandingPage';
import DashboardLayout from './layouts/DashboardLayout';
import OrdersPage from './pages/dashboard/OrdersPage';
import InvoicesPage from './pages/dashboard/InvoicesPage';
import TicketsPage from './pages/dashboard/TicketsPage';
import './App.css';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        
        <Route path="/dashboard" element={<DashboardLayout />}>
          <Route path="orders" element={<OrdersPage />} />
          <Route path="invoices" element={<InvoicesPage />} />
          <Route path="tickets" element={<TicketsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
