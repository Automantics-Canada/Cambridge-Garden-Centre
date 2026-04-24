import React, { useState, useEffect, useCallback } from 'react';
import { useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import api from '../../api/axios';
import { 
  FileCheck, 
  AlertCircle, 
  Clock, 
  TrendingUp, 
  Search, 
  ChevronRight,
  Filter,
  Users
} from 'lucide-react';
import { Skeleton } from '../../components/Skeleton';
import Loader from '../../components/Loader';

export default function Dashboard() {
  const user = useSelector((state) => state.auth.user);
  const navigate = useNavigate();
  const [stats, setStats] = useState({
    totalMonthly: 0,
    pendingCount: 0,
    disputedCount: 0,
    savingsDetected: 0
  });
  const [recentInvoices, setRecentInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [suppliers, setSuppliers] = useState([]);
  
  // Dashboard Filters
  const [buyerType, setBuyerType] = useState('');
  const [supplierId, setSupplierId] = useState('');

  const fetchDashboardData = useCallback(async () => {
    setLoading(true);
    try {
      const [resInvoices, resSuppliers] = await Promise.all([
        api.get('/api/invoices'), 
        api.get('/api/suppliers')
      ]);
      
      const invoices = resInvoices.data;
      setRecentInvoices(invoices.slice(0, 5));
      setSuppliers(resSuppliers.data);

      // In real scenario, backend should return these stats. Calculating here for v1.
      const now = new Date();
      const thisMonth = now.getMonth();
      const thisYear = now.getFullYear();

      const monthlyInvoices = invoices.filter(inv => {
        const d = new Date(inv.receivedAt);
        return d.getMonth() === thisMonth && d.getFullYear() === thisYear;
      });

      setStats({
        totalMonthly: monthlyInvoices.length,
        pendingCount: invoices.filter(i => i.status === 'PENDING_REVIEW').length,
        disputedCount: invoices.filter(i => i.status === 'DISPUTED').length,
        savingsDetected: invoices.reduce((acc, inv) => {
          const savings = inv.lineItems?.reduce((s, li) => s + (li.rateDiscrepancy || 0), 0) || 0;
          return acc + (inv.status === 'DISPUTED' ? Number(savings) : 0);
        }, 0)
      });

    } catch (err) {
      console.error('Error fetching dashboard data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboardData();
  }, [fetchDashboardData]);

  if (loading) return <DashboardSkeleton />;

  return (
    <div className="max-w-7xl mx-auto space-y-8 pb-12">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold text-gray-900 tracking-tight flex items-center gap-2">
            Dashboard
          </h1>
          <p className="text-gray-500 mt-1 font-medium">
            Welcome back, <span className="text-[#1B4332] font-bold">{user?.name || 'User'}</span>. Here is what's happening today.
          </p>
        </div>
        
      </div>

      {/* KPI Widgets */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
        <div className="bg-white p-6 rounded-3xl border border-gray-200 shadow-sm hover:shadow-md transition-all group">
          <div className="flex items-center justify-between mb-4">
            <div className="p-3 bg-blue-50 rounded-2xl group-hover:bg-blue-600 transition-colors">
              <Clock className="w-6 h-6 text-blue-600 group-hover:text-white" />
            </div>
            <span className="text-xs font-bold text-blue-600 bg-blue-50 px-2 py-1 rounded-full">{stats.pendingCount} ACTIVE</span>
          </div>
          <p className="text-gray-500 text-sm font-medium">Pending Review</p>
          <p className="text-3xl font-black text-gray-900 mt-1">{stats.pendingCount}</p>
        </div>

        <div className="bg-white p-6 rounded-3xl border border-gray-200 shadow-sm hover:shadow-md transition-all group">
          <div className="flex items-center justify-between mb-4">
            <div className="p-3 bg-red-50 rounded-2xl group-hover:bg-red-600 transition-colors">
              <AlertCircle className="w-6 h-6 text-red-600 group-hover:text-white" />
            </div>
          </div>
          <p className="text-gray-500 text-sm font-medium">Disputed Invoices</p>
          <p className="text-3xl font-black text-gray-900 mt-1">{stats.disputedCount}</p>
        </div>

        <div className="bg-white p-6 rounded-3xl border border-gray-200 shadow-sm hover:shadow-md transition-all group">
          <div className="flex items-center justify-between mb-4">
            <div className="p-3 bg-green-50 rounded-2xl group-hover:bg-green-600 transition-colors">
              <FileCheck className="w-6 h-6 text-green-600 group-hover:text-white" />
            </div>
          </div>
          <p className="text-gray-500 text-sm font-medium">Monthly Processed</p>
          <p className="text-3xl font-black text-gray-900 mt-1">{stats.totalMonthly}</p>
        </div>

      </div>

      {/* Main Grid: Recent Invoices & Supplier Status */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
         {/* Recent Invoices */}
         <div className="lg:col-span-2 bg-white rounded-3xl border border-gray-200 shadow-sm overflow-hidden flex flex-col">
            <div className="p-6 border-b flex items-center justify-between">
               <h3 className="text-xl font-bold text-gray-900">Recent Verification Activity</h3>
               <button 
                onClick={() => navigate('/dashboard/invoices')}
                className="text-sm font-bold text-blue-600 hover:underline"
               >
                 View all
               </button>
            </div>
            <div className="flex-1 overflow-y-auto">
               <table className="w-full text-left">
                  <thead className="bg-gray-50/50 text-[10px] font-bold text-gray-400 uppercase tracking-widest border-b">
                     <tr>
                        <th className="px-6 py-3">Invoice</th>
                        <th className="px-6 py-3">Supplier</th>
                        <th className="px-6 py-3">Amount</th>
                        <th className="px-6 py-3">Status</th>
                     </tr>
                  </thead>
                  <tbody className="divide-y">
                     {recentInvoices.map(inv => (
                        <tr 
                          key={inv.id} 
                          className="hover:bg-gray-50 transition-colors cursor-pointer group"
                          onClick={() => navigate(`/dashboard/invoices/${inv.id}`)}
                        >
                           <td className="px-6 py-4">
                              <p className="text-sm font-bold text-gray-900 group-hover:text-blue-600 transition-colors">{inv.invoiceNumber}</p>
                              <p className="text-[10px] text-gray-400 uppercase font-medium">{new Date(inv.receivedAt).toLocaleDateString()}</p>
                           </td>
                           <td className="px-6 py-4">
                              <p className="text-sm text-gray-700 font-medium">{inv.supplier?.name}</p>
                           </td>
                           <td className="px-6 py-4">
                              <p className="text-sm font-bold text-gray-900">${Number(inv.totalAmount).toFixed(2)}</p>
                           </td>
                           <td className="px-6 py-4">
                              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-tighter shadow-sm border ${
                                inv.status === 'VERIFIED' ? 'bg-green-100 text-green-800 border-green-200' :
                                inv.status === 'DISPUTED' ? 'bg-red-100 text-red-800 border-red-200' :
                                'bg-yellow-100 text-yellow-800 border-yellow-200'
                              }`}>
                                {inv.status}
                              </span>
                           </td>
                        </tr>
                     ))}
                  </tbody>
               </table>
            </div>
         </div>

         {/* Supplier Quick Links */}
         <div className="bg-white rounded-3xl border border-gray-200 shadow-sm p-6 flex flex-col space-y-6">
            <h3 className="text-xl font-bold text-gray-900">Management Links</h3>
            
            <div className="space-y-3">
               <button 
                onClick={() => navigate('/dashboard/rates')}
                className="w-full flex items-center justify-between p-4 rounded-2xl bg-gray-50 hover:bg-gray-100 transition-all group"
               >
                  <div className="flex items-center gap-3">
                     <div className="p-2 bg-white rounded-xl shadow-sm border border-gray-100 group-hover:bg-blue-600 transition-colors">
                        <TrendingUp className="w-5 h-5 text-blue-600 group-hover:text-white" />
                     </div>
                     <div className="text-left">
                        <p className="text-sm font-bold text-gray-900">Negotiated Rates</p>
                        <p className="text-xs text-gray-500">Update supplier pricing</p>
                     </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-gray-300" />
               </button>

               <button 
                onClick={() => navigate('/dashboard/supplier')}
                className="w-full flex items-center justify-between p-4 rounded-2xl bg-gray-50 hover:bg-gray-100 transition-all group"
               >
                  <div className="flex items-center gap-3">
                     <div className="p-2 bg-white rounded-xl shadow-sm border border-gray-100 group-hover:bg-indigo-600 transition-colors">
                        <Users className="w-5 h-5 text-indigo-600 group-hover:text-white" />
                     </div>
                     <div className="text-left">
                        <p className="text-sm font-bold text-gray-900">Manage Suppliers</p>
                        <p className="text-xs text-gray-500">Directory & identifiers</p>
                     </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-gray-300" />
               </button>
            </div>

            <div className="bg-blue-50/50 p-4 rounded-2xl border border-blue-100">
               <p className="text-blue-900 font-bold text-sm mb-1 italic px-1">"Efficiency Tip"</p>
               <p className="text-xs text-blue-700 leading-relaxed px-1">
                 Ensure all Spruce orders are imported before verifying invoices tomaximize automated matching accuracy.
               </p>
            </div>
         </div>
      </div>
    </div>
  );
}
function DashboardSkeleton() {
  return (
    <div className="max-w-7xl mx-auto space-y-8 pb-12">
      <div className="flex flex-col gap-2">
        <Skeleton variant="text" width="200px" height="32px" />
        <Skeleton variant="text" width="300px" height="20px" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="bg-white p-6 rounded-3xl border border-gray-200 shadow-sm space-y-4">
            <div className="flex items-center justify-between">
              <Skeleton variant="rectangle" width="48px" height="48px" className="rounded-2xl" />
              <Skeleton variant="rectangle" width="80px" height="24px" className="rounded-full" />
            </div>
            <div className="space-y-2">
              <Skeleton variant="text" width="100px" height="14px" />
              <Skeleton variant="text" width="60px" height="32px" />
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 bg-white rounded-3xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="p-6 border-b flex justify-between">
            <Skeleton variant="text" width="250px" height="24px" />
            <Skeleton variant="text" width="60px" height="16px" />
          </div>
          <div className="p-6 space-y-4">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="flex justify-between items-center py-2 border-b border-gray-50 last:border-0">
                <div className="space-y-2">
                  <Skeleton variant="text" width="120px" height="16px" />
                  <Skeleton variant="text" width="80px" height="12px" />
                </div>
                <Skeleton variant="text" width="100px" height="16px" />
                <Skeleton variant="text" width="80px" height="16px" />
                <Skeleton variant="rectangle" width="70px" height="20px" className="rounded-full" />
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-3xl border border-gray-200 shadow-sm p-6 space-y-6">
          <Skeleton variant="text" width="180px" height="24px" />
          <div className="space-y-4">
            {[...Array(2)].map((_, i) => (
              <div key={i} className="flex items-center justify-between p-4 rounded-2xl bg-gray-50">
                <div className="flex items-center gap-3">
                  <Skeleton variant="rectangle" width="40px" height="40px" className="rounded-xl" />
                  <div className="space-y-2">
                    <Skeleton variant="text" width="120px" height="16px" />
                    <Skeleton variant="text" width="100px" height="12px" />
                  </div>
                </div>
                <Skeleton variant="rectangle" width="16px" height="16px" />
              </div>
            ))}
          </div>
          <Skeleton variant="rectangle" height="100px" className="rounded-2xl" />
        </div>
      </div>
    </div>
  );
}
