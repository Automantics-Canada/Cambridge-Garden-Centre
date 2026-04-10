import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api/axios';
import { 
  Search, 
  Eye, 
  AlertCircle, 
  CheckCircle, 
  Upload, 
  FileText, 
  AlertTriangle,
  ChevronRight,
  History
} from 'lucide-react';
import toast from 'react-hot-toast';
import Loader from '../../components/Loader';

const STATUS_TABS = [
  { id: 'ALL', name: 'All Invoices' },
  { id: 'PENDING_REVIEW', name: 'Pending Review' },
  { id: 'VERIFIED', name: 'Verified' },
  { id: 'DISPUTED', name: 'Disputed' }
];

export default function InvoicesPage() {
  const navigate = useNavigate();
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('ALL');
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef(null);
  const [search, setSearch] = useState('');

  const fetchInvoices = useCallback(async () => {
    setLoading(true);
    try {
      const params = {
        status: activeTab === 'ALL' ? undefined : activeTab,
      };
      const res = await api.get('/invoice', { params });
      setInvoices(res.data);
    } catch (err) {
      console.error('Error fetching invoices:', err);
      toast.error('Failed to load invoices');
    } finally {
      setLoading(false);
    }
  }, [activeTab]);

  useEffect(() => {
    fetchInvoices();
  }, [fetchInvoices]);

  const handleFileUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.name.match(/\.(jpg|jpeg|png)$/i)) {
      toast.error('Please upload a valid JPG or PNG file');
      return;
    }

    const formData = new FormData();
    formData.append('file', file);
    formData.append('fromEmail', 'staff_upload@cambridgegardencentre.ca');
    formData.append('subject', `Manual Upload: ${file.name}`);

    setIsUploading(true);
    try {
      const res = await api.post('/invoice/mock-email', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success('Invoice uploaded and processing!');
      fetchInvoices();
      // Optionally navigate to the detail page immediately
      if (res.data.invoice?.id) {
         navigate(`/dashboard/invoices/${res.data.invoice.id}`);
      }
    } catch (err) {
      toast.error('Upload failed');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const filteredInvoices = invoices.filter(inv => 
    inv.invoiceNumber?.toLowerCase().includes(search.toLowerCase()) ||
    inv.supplier?.name?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex flex-col h-full space-y-4">
      {/* Header */}
      <div className="sm:flex sm:items-center justify-between bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
        <div className="sm:flex-auto">
          <h1 className="text-2xl font-semibold text-gray-900">Invoices</h1>
          <p className="mt-2 text-sm text-gray-700">
            Review and verify incoming invoices from suppliers and trucking companies.
          </p>
        </div>
        <div className="mt-4 sm:ml-16 sm:mt-0 sm:flex-none">
          <input 
            type="file" 
            accept=".jpg,.jpeg,.png" 
            ref={fileInputRef} 
            onChange={handleFileUpload} 
            className="hidden" 
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            className="flex items-center gap-2 bg-gray-900 hover:bg-black text-white px-4 py-2 rounded-lg font-medium text-sm transition-all shadow-md disabled:opacity-50"
          >
            {isUploading ? <Loader className="w-4 h-4" /> : <Upload className="w-4 h-4" />}
            {isUploading ? 'Processing...' : 'Manual Upload'}
          </button>
        </div>
      </div>

      {/* Tabs & Search */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="border-b border-gray-200">
          <nav className="flex -mb-px" aria-label="Tabs">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`
                  flex-1 py-4 px-4 text-sm font-medium text-center border-b-2 transition-all
                  ${activeTab === tab.id 
                    ? 'text-green-600 border-green-600 bg-green-50/20' 
                    : 'text-gray-500 border-transparent hover:text-gray-700 hover:bg-gray-50'}
                `}
              >
                {tab.name}
              </button>
            ))}
          </nav>
        </div>

        <div className="p-4">
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input 
              type="text" 
              placeholder="Search by invoice # or supplier..."
              className="w-full pl-10 pr-4 py-2 border rounded-xl text-sm outline-none focus:ring-2 focus:ring-green-100 transition-all"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden flex flex-col">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50 sticky top-0">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">Invoice</th>
                <th className="px-6 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">Supplier</th>
                <th className="px-6 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">Date</th>
                <th className="px-6 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">Total</th>
                <th className="px-6 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider text-center">Lines</th>
                <th className="px-6 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-6 py-3 text-right text-xs font-bold text-gray-500 uppercase tracking-wider">Action</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {loading ? (
                <tr><td colSpan="7"><Loader message="Loading invoices..." /></td></tr>
              ) : filteredInvoices.length === 0 ? (
                <tr><td colSpan="7" className="px-6 py-12 text-center text-gray-500">No invoices found.</td></tr>
              ) : (
                filteredInvoices.map((inv) => {
                  const flaggedCount = inv.lineItems?.filter(li => li.flag !== 'OK').length || 0;
                  return (
                    <tr key={inv.id} className="hover:bg-gray-50/50 transition-colors cursor-pointer group" onClick={() => navigate(`/dashboard/invoices/${inv.id}`)}>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center gap-3">
                           <div className="p-2 bg-gray-100 rounded-lg group-hover:bg-green-100 transition-colors">
                              <FileText className="w-5 h-5 text-gray-400 group-hover:text-green-600" />
                           </div>
                           <div className="text-sm font-bold text-gray-900">{inv.invoiceNumber}</div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 font-medium">
                        {inv.supplier?.name || '-'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {new Date(inv.invoiceDate).toLocaleDateString()}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-bold text-gray-900">
                        ${Number(inv.totalAmount).toFixed(2)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-center">
                        <div className="flex items-center justify-center gap-2">
                           <span className="text-xs font-medium text-gray-600">{inv.lineItems?.length || 0}</span>
                           {flaggedCount > 0 && (
                             <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px] font-bold">
                               <AlertTriangle className="w-2.5 h-2.5" /> {flaggedCount}
                             </span>
                           )}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                          inv.status === 'VERIFIED' ? 'bg-green-100 text-green-800 border border-green-200' :
                          inv.status === 'DISPUTED' ? 'bg-red-100 text-red-800 border border-red-200' :
                          'bg-yellow-100 text-yellow-800 border border-yellow-200'
                        }`}>
                          {inv.status.replace('_', ' ')}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <button className="text-gray-400 group-hover:text-green-600 transition-colors p-2 rounded-lg group-hover:bg-green-50">
                           <ChevronRight className="w-5 h-5" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
