import React, { useState, useEffect, useCallback } from 'react';
import api from '../../api/axios';
import { 
  FileText, 
  Truck, 
  ShoppingCart, 
  CheckCircle, 
  AlertCircle, 
  ChevronRight, 
  Search,
  Maximize2,
  Package,
  AlertTriangle,
  History
} from 'lucide-react';
import Loader from '../../components/Loader';
import toast from 'react-hot-toast';

export default function VerificationDesk() {
  const [invoices, setInvoices] = useState([]);
  const [selectedInvoice, setSelectedInvoice] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('ALL');

  const fetchInvoices = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/api/invoices');
      setInvoices(res.data);
      if (res.data.length > 0 && !selectedInvoice) {
        // Fetch full details for the first invoice
        fetchInvoiceDetails(res.data[0].id);
      }
    } catch (err) {
      toast.error('Failed to load invoices');
    } finally {
      setLoading(false);
    }
  }, [selectedInvoice]);

  const fetchInvoiceDetails = async (id) => {
    try {
      const res = await api.get(`/api/invoices/${id}`);
      setSelectedInvoice(res.data);
    } catch (err) {
      toast.error('Failed to load invoice details');
    }
  };

  useEffect(() => {
    fetchInvoices();
  }, []);

  const filteredInvoices = invoices.filter(inv => {
    const matchesSearch = inv.invoiceNumber.toLowerCase().includes(search.toLowerCase()) || 
                         inv.supplier?.name.toLowerCase().includes(search.toLowerCase());
    if (filterStatus === 'ALL') return matchesSearch;
    return matchesSearch && inv.status === filterStatus;
  });

  if (loading && invoices.length === 0) return <Loader message="Setting up your verification desk..." />;

  return (
    <div className="flex h-full bg-[#F3F4F6] -m-8 relative overflow-hidden">
      {/* 1. Selection Sidebar */}
      <div className="w-80 bg-white border-r flex flex-col shadow-sm z-20">
        <div className="p-6 border-b">
          <h2 className="text-xl font-black text-gray-900 tracking-tight">Match Desk</h2>
          <p className="text-xs text-gray-400 font-bold uppercase mt-1 tracking-widest">Awaiting Verification</p>
          
          <div className="mt-4 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300" />
            <input 
              type="text" 
              placeholder="Search invoices..."
              className="w-full pl-10 pr-4 py-2 bg-gray-50 border-none rounded-xl text-sm focus:ring-2 focus:ring-green-500 outline-none transition-all"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {filteredInvoices.map((inv) => (
            <button
              key={inv.id}
              onClick={() => fetchInvoiceDetails(inv.id)}
              className={`w-full text-left p-4 rounded-2xl transition-all border ${
                selectedInvoice?.id === inv.id 
                ? 'bg-[#1B4332] border-[#1B4332] shadow-lg shadow-green-100 text-white' 
                : 'bg-white border-gray-100 hover:border-green-200 hover:bg-green-50/30'
              }`}
            >
              <div className="flex justify-between items-start mb-1">
                <span className="text-sm font-black tracking-tight">{inv.invoiceNumber}</span>
                <span className={`text-[8px] font-black uppercase px-2 py-0.5 rounded-full ${
                  inv.status === 'VERIFIED' ? 'bg-green-400/20 text-green-100' : 'bg-yellow-400/20 text-yellow-100'
                }`}>
                  {inv.status}
                </span>
              </div>
              <p className={`text-xs font-bold ${selectedInvoice?.id === inv.id ? 'text-green-100' : 'text-gray-500'}`}>
                {inv.supplier?.name}
              </p>
              <div className="mt-3 flex items-center justify-between">
                <p className="text-sm font-black">${Number(inv.totalAmount).toFixed(2)}</p>
                <div className="flex -space-x-1.5">
                   {[...Array(2)].map((_, i) => (
                     <div key={i} className={`w-5 h-5 rounded-full border-2 ${selectedInvoice?.id === inv.id ? 'border-[#1B4332] bg-green-800' : 'border-white bg-gray-100'} flex items-center justify-center`}>
                        <FileText className="w-2.5 h-2.5 opacity-50" />
                     </div>
                   ))}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* 2. The Desk - Triple Panel Match View */}
      <div className="flex-1 flex flex-col overflow-hidden bg-gray-100">
        {!selectedInvoice ? (
          <div className="flex-1 flex items-center justify-center flex-col text-gray-400">
            <div className="p-8 bg-white rounded-full shadow-sm mb-6">
              <History className="w-16 h-16 text-gray-200" />
            </div>
            <p className="text-lg font-bold">Select an invoice to begin verification</p>
          </div>
        ) : (
          <>
            {/* Context Bar */}
            <div className="h-16 bg-white border-b px-8 flex items-center justify-between z-10">
              <div className="flex items-center gap-6">
                 <div className="flex items-center gap-2">
                    <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Supplier</span>
                    <span className="text-sm font-black text-gray-900">{selectedInvoice.supplier?.name}</span>
                 </div>
                 <div className="w-px h-6 bg-gray-200" />
                 <div className="flex items-center gap-2">
                    <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest">3-Way Match Check</span>
                    <div className="flex items-center gap-1.5">
                       <span className="w-2 h-2 rounded-full bg-green-500 shadow-sm shadow-green-200" />
                       <span className="text-[11px] font-black text-green-700 uppercase tracking-tighter">Ready to Verify</span>
                    </div>
                 </div>
              </div>

              <div className="flex gap-3">
                 <button className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold text-xs rounded-xl transition-all">Mark Disputed</button>
                 <button className="px-6 py-2 bg-[#2D6A4F] hover:bg-[#1B4332] text-white font-black text-xs rounded-xl transition-all shadow-md">Complete Verification</button>
              </div>
            </div>

            {/* Triple Panels */}
            <div className="flex-1 flex overflow-hidden p-6 gap-6">
              {/* Panel 1: THE INVOICE (Left) */}
              <div className="flex-1 flex flex-col bg-white rounded-3xl shadow-sm border border-gray-200 overflow-hidden">
                <div className="p-5 border-b flex items-center justify-between bg-gray-50/50">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-white rounded-xl shadow-sm border border-gray-100">
                      <FileText className="w-5 h-5 text-[#2D6A4F]" />
                    </div>
                    <span className="text-sm font-black text-gray-900 uppercase tracking-tight">1. Vendor Invoice</span>
                  </div>
                  <button className="p-1.5 hover:bg-gray-200 rounded-lg transition-colors">
                    <Maximize2 className="w-4 h-4 text-gray-400" />
                  </button>
                </div>
                
                <div className="flex-1 overflow-y-auto p-6 space-y-6">
                  {/* Digital Preview */}
                  <div className="aspect-[4/3] bg-gray-900 rounded-2xl relative overflow-hidden group cursor-zoom-in">
                    <img 
                      src={selectedInvoice.fileUrl.startsWith('http') ? selectedInvoice.fileUrl : `http://localhost:4000${selectedInvoice.fileUrl}`} 
                      className="w-full h-full object-contain opacity-90 group-hover:opacity-100 transition-opacity"
                      alt="Invoice"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent flex flex-col justify-end p-4">
                       <p className="text-white text-xs font-bold uppercase tracking-widest">Original Document</p>
                    </div>
                  </div>

                  {/* Extracted Billing Table */}
                  <div className="space-y-4">
                    <h4 className="text-[10px] font-black text-gray-400 uppercase tracking-widest px-1">Billed Items Extraction</h4>
                    <div className="space-y-2">
                       {selectedInvoice.lineItems?.map((li, idx) => (
                         <div key={idx} className="p-4 bg-gray-50 rounded-2xl border border-gray-100 group">
                            <div className="flex justify-between items-start mb-2">
                               <p className="text-sm font-black text-gray-900 leading-tight flex-1 pr-4">{li.description}</p>
                               <p className="text-sm font-black text-[#2D6A4F] whitespace-nowrap">${Number(li.lineTotal).toFixed(2)}</p>
                            </div>
                            <div className="flex items-center gap-4 text-[10px] text-gray-500 font-bold uppercase tracking-tighter">
                               <span>Qty: {Number(li.quantity).toFixed(0)} {li.unit}</span>
                               <div className="w-1 h-1 bg-gray-300 rounded-full" />
                               <span>Rate: ${Number(li.unitRate).toFixed(2)}</span>
                               <div className="w-1 h-1 bg-gray-300 rounded-full" />
                               <span className="text-green-600">PO: {li.poNumber || 'N/A'}</span>
                            </div>
                         </div>
                       ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Panel 2: DELIVERY EVIDENCE (Middle) */}
              <div className="flex-1 flex flex-col bg-white rounded-3xl shadow-sm border border-gray-200 overflow-hidden">
                <div className="p-5 border-b flex items-center justify-between bg-gray-50/50">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-white rounded-xl shadow-sm border border-gray-100">
                      <Truck className="w-5 h-5 text-purple-600" />
                    </div>
                    <span className="text-sm font-black text-gray-900 uppercase tracking-tight">2. Delivery Tickets</span>
                  </div>
                  <span className="bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-widest">
                    {selectedInvoice.lineItems?.reduce((acc, li) => acc + (li.matchedTickets?.length || 0), 0)} Linked
                  </span>
                </div>

                <div className="flex-1 overflow-y-auto p-6">
                   <div className="space-y-6">
                      {selectedInvoice.lineItems?.map((li, idx) => (
                        <div key={idx} className="space-y-3">
                           <div className="flex items-center gap-2 px-1">
                              <span className="w-4 h-4 bg-gray-100 rounded-full flex items-center justify-center text-[10px] font-black text-gray-400">{idx + 1}</span>
                              <p className="text-[11px] font-black text-gray-400 uppercase tracking-tighter truncate w-40">{li.description}</p>
                           </div>

                           {!li.matchedTickets || li.matchedTickets.length === 0 ? (
                             <div className="p-6 border-2 border-dashed border-red-100 bg-red-50/30 rounded-3xl flex flex-col items-center text-center">
                                <AlertTriangle className="w-8 h-8 text-red-300 mb-2" />
                                <p className="text-xs font-black text-red-800 uppercase tracking-tight">Missing Ticket Link</p>
                                <p className="text-[10px] text-red-500 font-bold mt-1">No delivery evidence found for this material.</p>
                             </div>
                           ) : (
                             <div className="space-y-3">
                                {li.matchedTickets.map((t, tIdx) => (
                                  <div key={tIdx} className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden flex flex-col">
                                     <div className="flex p-3 items-center gap-3">
                                        <div className="w-12 h-12 bg-gray-50 rounded-xl overflow-hidden border">
                                           <img 
                                              src={t.imageUrl.startsWith('http') ? t.imageUrl : `http://localhost:4000${t.imageUrl}`} 
                                              className="w-full h-full object-cover"
                                              alt="Ticket"
                                           />
                                        </div>
                                        <div className="flex-1">
                                           <p className="text-[10px] font-black text-gray-900 leading-tight">Ticket #{t.ticketNumber || 'N/A'}</p>
                                           <p className="text-[9px] text-gray-400 font-bold uppercase tracking-wider">{t.material || 'Material'}</p>
                                        </div>
                                        <div className="text-right">
                                           <p className="text-xs font-black text-purple-600">{Number(t.quantity).toFixed(0)} {t.unit}</p>
                                           <p className="text-[8px] text-gray-400 font-bold uppercase">{new Date(t.ticketDate || t.receivedAt).toLocaleDateString()}</p>
                                        </div>
                                     </div>
                                     <div className="px-3 pb-3">
                                        <div className="h-1.5 w-full bg-gray-50 rounded-full overflow-hidden">
                                           <div className="h-full bg-purple-500 w-[95%]" />
                                        </div>
                                     </div>
                                  </div>
                                ))}
                             </div>
                           )}
                        </div>
                      ))}
                   </div>
                </div>
              </div>

              {/* Panel 3: SPRUCE ORDER (Right) */}
              <div className="flex-1 flex flex-col bg-white rounded-3xl shadow-sm border border-gray-200 overflow-hidden">
                <div className="p-5 border-b flex items-center justify-between bg-gray-50/50">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-white rounded-xl shadow-sm border border-gray-100">
                      <ShoppingCart className="w-5 h-5 text-blue-600" />
                    </div>
                    <span className="text-sm font-black text-gray-900 uppercase tracking-tight">3. Spruce Auth</span>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-6">
                   <div className="space-y-6">
                      {selectedInvoice.lineItems?.map((li, idx) => (
                        <div key={idx} className="space-y-3">
                           <div className="flex items-center gap-2 px-1">
                              <span className="w-4 h-4 bg-gray-100 rounded-full flex items-center justify-center text-[10px] font-black text-gray-400">{idx + 1}</span>
                              <p className="text-[11px] font-black text-gray-400 uppercase tracking-tighter truncate w-40">{li.description}</p>
                           </div>

                           {!li.matchedOrder ? (
                             <div className="p-6 border-2 border-dashed border-gray-100 bg-gray-50/50 rounded-3xl flex flex-col items-center text-center">
                                <Package className="w-8 h-8 text-gray-200 mb-2" />
                                <p className="text-xs font-black text-gray-400 uppercase tracking-tight">No Order Link</p>
                                <p className="text-[10px] text-gray-400 font-bold mt-1">Manual association required.</p>
                             </div>
                           ) : (
                             <div className="bg-gradient-to-br from-blue-50 to-indigo-50/30 rounded-3xl p-5 border border-blue-100 relative overflow-hidden group">
                                <div className="absolute top-0 right-0 p-3 opacity-10 group-hover:scale-125 transition-transform">
                                   <ShoppingCart className="w-12 h-12 text-blue-600" />
                                </div>
                                <div className="relative z-10">
                                   <div className="flex justify-between items-start mb-4">
                                      <div>
                                         <p className="text-[10px] font-black text-blue-600 uppercase tracking-widest leading-none mb-1">Authorization</p>
                                         <p className="text-sm font-black text-gray-900 leading-none">{li.matchedOrder.spruceOrderId}</p>
                                      </div>
                                      <span className="text-[10px] font-black text-indigo-700 bg-indigo-100 px-2 py-0.5 rounded-full">PO: {li.matchedOrder.poNumber || 'None'}</span>
                                   </div>

                                   <div className="grid grid-cols-2 gap-4">
                                      <div>
                                         <p className="text-[9px] font-bold text-gray-400 uppercase">Product</p>
                                         <p className="text-[11px] font-black text-gray-700 truncate">{li.matchedOrder.product}</p>
                                      </div>
                                      <div>
                                         <p className="text-[9px] font-bold text-gray-400 uppercase">Authorized Qty</p>
                                         <p className="text-sm font-black text-gray-900">{Number(li.matchedOrder.quantity).toFixed(0)} {li.matchedOrder.unit}</p>
                                      </div>
                                   </div>

                                   <div className="mt-4 pt-4 border-t border-blue-100/50 flex items-center justify-between">
                                      <p className="text-[9px] font-bold text-blue-500 uppercase">Customer: {li.matchedOrder.customerName}</p>
                                      <CheckCircle className="w-4 h-4 text-green-500" />
                                   </div>
                                </div>
                             </div>
                           )}
                        </div>
                      ))}
                   </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
