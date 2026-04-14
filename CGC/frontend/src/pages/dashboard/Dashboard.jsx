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

  if (loading) return <Loader message="Analyzing operations data..." />;

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
        
        {/* Dashboard Filters */}
        <div className="flex flex-wrap gap-3 bg-white p-3 rounded-2xl border shadow-sm items-center">
           <div className="flex items-center gap-2 text-xs font-bold text-gray-400 uppercase tracking-wider px-2">
             <Filter className="w-3 h-3" /> Global Filters
           </div>
           <select 
            className="text-sm border-none bg-gray-50 rounded-lg px-3 py-1.5 focus:ring-0 outline-none font-medium text-gray-700"
            value={buyerType}
            onChange={e => setBuyerType(e.target.value)}
           >
              <option value="">All Buyer Types</option>
              <option value="RETAIL">Retail</option>
              <option value="CONTRACTOR">Contractor</option>
           </select>
           <select 
            className="text-sm border-none bg-gray-50 rounded-lg px-3 py-1.5 focus:ring-0 outline-none font-medium text-gray-700 max-w-[150px]"
            value={supplierId}
            onChange={e => setSupplierId(e.target.value)}
           >
              <option value="">All Suppliers</option>
              {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
           </select>
        </div>
      </div>

      {/* KPI Widgets */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
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

        <div className="bg-green-600 p-6 rounded-3xl shadow-lg shadow-green-100 relative overflow-hidden group">
          <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:scale-125 transition-transform duration-500">
             <TrendingUp className="w-24 h-24 text-white" />
          </div>
          <div className="relative z-10">
            <p className="text-green-100 text-sm font-bold uppercase tracking-wider">Potential Savings</p>
            <p className="text-4xl font-black text-white mt-2">${Number(stats.savingsDetected).toFixed(2)}</p>
            <p className="text-green-100 text-xs mt-2 italic font-medium">From detected discrepancies</p>
          </div>
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
