import React, { useState, useEffect, useCallback } from 'react';
import api from '../../api/axios';
import { 
  FileText, 
  Truck, 
  ShoppingCart, 
  CheckCircle, 
  AlertCircle, 
  Search,
  Maximize2,
  Package,
  AlertTriangle,
  History,
  X,
  Link,
  ChevronRight,
  ExternalLink
} from 'lucide-react';
import { SidebarSkeleton, Skeleton } from '../../components/Skeleton';
import Loader from '../../components/Loader';
import toast from 'react-hot-toast';

export default function VerificationDesk() {
  const [invoices, setInvoices] = useState([]);
  const [selectedInvoice, setSelectedInvoice] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('ALL');
  const [isProcessing, setIsProcessing] = useState(false);
  
  // Interaction states
  const [zoomedImage, setZoomedImage] = useState(null);
  const [showDisputeInput, setShowDisputeInput] = useState(false);
  const [disputeNote, setDisputeNote] = useState('');
  const [linkingLineItem, setLinkingLineItem] = useState(null); // { id, type: 'order' | 'ticket' }
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);

  const fetchInvoices = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/api/invoices');
      setInvoices(res.data);
      // Auto-select first if none selected
      if (res.data.length > 0 && !selectedInvoice) {
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
      setDisputeNote(res.data.disputeNote || '');
      setShowDisputeInput(false);
    } catch (err) {
      toast.error('Failed to load invoice details');
    }
  };

  useEffect(() => {
    fetchInvoices();
  }, []);

  const handleVerify = async () => {
    if (!selectedInvoice) return;
    setIsProcessing(true);
    try {
      await api.post(`/api/invoices/${selectedInvoice.id}/verify`);
      toast.success('Invoice verified successfully');
      fetchInvoices();
      fetchInvoiceDetails(selectedInvoice.id);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Verification failed');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDispute = async () => {
    if (!selectedInvoice) return;
    if (!disputeNote.trim()) {
      toast.error('Please enter a dispute note');
      return;
    }
    setIsProcessing(true);
    try {
      await api.post(`/api/invoices/${selectedInvoice.id}/dispute`, { note: disputeNote });
      toast.success('Invoice marked as disputed');
      setShowDisputeInput(false);
      fetchInvoices();
      fetchInvoiceDetails(selectedInvoice.id);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to mark as disputed');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleLinkOrder = async (orderId) => {
    setIsProcessing(true);
    try {
      await api.post('/api/invoices/line-items/link-order', {
        lineItemId: linkingLineItem.id,
        orderId
      });
      toast.success('Order linked successfully');
      setLinkingLineItem(null);
      fetchInvoiceDetails(selectedInvoice.id);
    } catch (err) {
      toast.error('Linking failed');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleLinkTickets = async (ticketId) => {
    setIsProcessing(true);
    try {
      // For now we link one ticket at a time from this UI
      await api.post('/api/invoices/line-items/link-tickets', {
        lineItemId: linkingLineItem.id,
        ticketIds: [ticketId]
      });
      toast.success('Ticket linked successfully');
      setLinkingLineItem(null);
      fetchInvoiceDetails(selectedInvoice.id);
    } catch (err) {
      toast.error('Ticket linking failed');
    } finally {
      setIsProcessing(false);
    }
  };

  const searchManualLinks = async (query) => {
    if (!query) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      const endpoint = linkingLineItem.type === 'order' ? '/api/orders' : '/api/tickets';
      const res = await api.get(endpoint, { params: { search: query } });
      setSearchResults(res.data);
    } catch (err) {
      console.error('Search error', err);
    } finally {
      setSearching(false);
    }
  };

  const filteredInvoices = invoices.filter(inv => {
    const matchesSearch = inv.invoiceNumber.toLowerCase().includes(search.toLowerCase()) || 
                         inv.supplier?.name.toLowerCase().includes(search.toLowerCase());
    if (filterStatus === 'ALL') return matchesSearch;
    return matchesSearch && inv.status === filterStatus;
  });

  if (loading && invoices.length === 0) return <VerificationDeskSkeleton />;

  const getFullUrl = (url) => {
    if (!url) return '';
    return url.startsWith('http') ? url : `https://cambridge-garden-centre-1.onrender.com${url}`;
  };

  return (
    <div className="flex h-full bg-[#F3F4F6] -m-8 relative overflow-hidden">
      {/* 1. Selection Sidebar */}
      <div className="w-80 bg-white border-r flex flex-col shadow-sm z-20">
        <div className="p-6 border-b">
          <h2 className="text-xl font-light text-gray-900 tracking-tight">Match Desk</h2>
          <div className="mt-4 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-800" />
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
                : 'bg-white border-gray-100 hover:border-green-200 hover:bg-green-50/30 text-gray-900'
              }`}
            >
              <div className="flex justify-between items-start mb-1">
                <span className="text-sm font-light tracking-tight">{inv.invoiceNumber}</span>
                <span className={`text-[8px] font-light uppercase px-2 py-0.5 rounded-full ${
                  inv.status === 'VERIFIED' ? 'bg-green-400/20 text-green-100' : 'bg-yellow-400/20 text-yellow-100'
                }`}>
                  {inv.status}
                </span>
              </div>
              <p className={`text-xs font-normal ${selectedInvoice?.id === inv.id ? 'text-green-100' : 'text-gray-800'}`}>
                {inv.supplier?.name}
              </p>
            </button>
          ))}
        </div>
      </div>

      {/* 2. The Desk */}
      <div className="flex-1 flex flex-col overflow-hidden bg-gray-100">
        {!selectedInvoice ? (
          <div className="flex-1 flex items-center justify-center flex-col text-gray-900">
            <History className="w-16 h-16 mb-4 opacity-20" />
            <p className="text-lg font-normal">Select an invoice to verify</p>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="h-20 bg-white border-b px-8 flex items-center justify-between z-10 shadow-sm">
              <div className="flex items-center gap-8">
                 <div className="flex flex-col">
                    <span className="text-[10px] font-light text-gray-900 uppercase tracking-widest">Supplier</span>
                    <span className="text-base font-light text-gray-900">{selectedInvoice.supplier?.name}</span>
                 </div>
                 <div className="w-px h-8 bg-gray-200" />
                 <div className="flex flex-col">
                    <span className="text-[10px] font-light text-gray-900 uppercase tracking-widest">Verification Status</span>
                    <div className="flex items-center gap-2 mt-0.5">
                       <div className={`w-2 h-2 rounded-full ${selectedInvoice.status === 'VERIFIED' ? 'bg-green-500' : 'bg-yellow-500'} animate-pulse`} />
                       <span className={`text-xs font-normal uppercase ${selectedInvoice.status === 'VERIFIED' ? 'text-green-700' : 'text-yellow-700'}`}>
                          {selectedInvoice.status.replace('_', ' ')}
                       </span>
                    </div>
                 </div>
              </div>

              <div className="flex gap-4">
                 {selectedInvoice.status === 'PENDING_REVIEW' && (
                    <>
                      <button 
                        onClick={() => setShowDisputeInput(!showDisputeInput)}
                        className={`px-6 py-2.5 rounded-xl font-normal text-xs transition-all border ${showDisputeInput ? 'bg-red-500 text-white border-red-500' : 'bg-white text-red-600 border-red-100 hover:bg-red-50'}`}
                      >
                        {showDisputeInput ? 'Cancel Dispute' : 'Flag Dispute'}
                      </button>
                      <button 
                        onClick={handleVerify}
                        disabled={isProcessing}
                        className="px-8 py-2.5 bg-[#1B4332] hover:bg-black text-white font-light text-xs rounded-xl transition-all shadow-lg shadow-green-200 flex items-center gap-2 disabled:opacity-50"
                      >
                        {isProcessing ? 'Processing...' : <><CheckCircle className="w-4 h-4" /> Final Approve</>}
                      </button>
                    </>
                 )}
                 {selectedInvoice.status !== 'PENDING_REVIEW' && (
                    <button 
                      onClick={() => api.post(`/api/invoices/${selectedInvoice.id}/reopen`).then(() => fetchInvoiceDetails(selectedInvoice.id))}
                      className="px-6 py-2.5 bg-gray-800 text-white rounded-xl font-light text-xs hover:bg-black transition-all"
                    >
                      Reopen Record
                    </button>
                 )}
              </div>
            </div>

            {/* Dispute Form Overlay */}
            {showDisputeInput && (
              <div className="bg-red-600 px-8 py-5 flex items-center gap-6 animate-in slide-in-from-top fade-in duration-300">
                 <AlertTriangle className="w-8 h-8 text-red-100" />
                 <div className="flex-1">
                    <label className="text-[10px] font-light text-red-100 uppercase tracking-widest">Why are you disputing this?</label>
                    <input 
                      type="text" 
                      placeholder="e.g. Quantity mismatch on gravel line... or Rate doesn't match negotiated..."
                      className="w-full bg-red-700/50 border-red-400/50 rounded-xl px-4 py-2 mt-1 text-white placeholder-red-300 outline-none focus:ring-2 focus:ring-white transition-all border text-sm"
                      value={disputeNote}
                      onChange={e => setDisputeNote(e.target.value)}
                      autoFocus
                    />
                 </div>
                 <button 
                  onClick={handleDispute}
                  disabled={isProcessing}
                  className="px-8 py-3 bg-white text-red-600 font-light text-xs rounded-xl hover:shadow-xl transition-all disabled:opacity-50"
                 >
                    {isProcessing ? 'Flagging...' : 'Confirm Dispute'}
                 </button>
              </div>
            )}

            {/* Main Content Area */}
            <div className="flex-1 flex overflow-hidden p-6 gap-6">
               {/* 1. DOCUMENT PREVIEW (Sticky Left) */}
               <div className="w-[450px] flex flex-col gap-4">
                  <div className="bg-white rounded-[40px] shadow-sm border p-2 flex-col flex overflow-hidden">
                     <div className="aspect-[3/4] rounded-[32px] overflow-hidden relative group cursor-pointer" onClick={() => setZoomedImage(getFullUrl(selectedInvoice.fileUrl))}>
                        <img src={getFullUrl(selectedInvoice.fileUrl)} className="w-full h-full object-cover grayscale-[30%] group-hover:grayscale-0 transition-all duration-500" alt="Invoice" />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent flex flex-col justify-end p-8">
                           <div className="flex items-center justify-between">
                              <span className="text-white text-[10px] font-light uppercase tracking-widest opacity-80">Original Bill</span>
                              <Maximize2 className="text-white w-5 h-5 opacity-0 group-hover:opacity-100 transition-opacity" />
                           </div>
                           <h3 className="text-white text-2xl font-light mt-1">INV-{selectedInvoice.invoiceNumber}</h3>
                        </div>
                     </div>
                  </div>
                  
                  <div className="bg-[#1B4332] rounded-[40px] p-8 text-white shadow-xl shadow-green-100">
                     <h4 className="text-[10px] font-light uppercase tracking-widest text-green-300/50 mb-4">Invoice Summary</h4>
                     <div className="space-y-4">
                        <div className="flex items-center justify-between">
                           <span className="text-sm font-normal opacity-60">Total Billed</span>
                           <span className="text-xl font-light">${Number(selectedInvoice.totalAmount).toLocaleString()}</span>
                        </div>
                        <div className="flex items-center justify-between border-t border-green-700/50 pt-4">
                           <span className="text-sm font-normal opacity-100 text-green-200">Payment Status</span>
                           <span className="text-xs font-light bg-white/10 px-3 py-1 rounded-full uppercase tracking-widest">{selectedInvoice.status}</span>
                        </div>
                     </div>
                  </div>
               </div>

               {/* 2. MATCHING LOGIC (Right Scrollable) */}
               <div className="flex-1 overflow-y-auto space-y-6 pr-4">
                  {selectedInvoice.lineItems?.map((li, idx) => (
                    <div key={li.id} className="bg-white rounded-[40px] p-8 border border-gray-100 shadow-sm hover:shadow-md transition-all">
                       <div className="flex items-start justify-between mb-8">
                          <div className="flex items-center gap-4">
                             <div className="w-12 h-12 bg-gray-50 rounded-2xl flex items-center justify-center font-light text-gray-800">
                                {String(idx + 1).padStart(2, '0')}
                             </div>
                             <div>
                                <h3 className="text-lg font-light text-gray-900 tracking-tight">{li.description}</h3>
                                <div className="flex items-center gap-3 mt-1">
                                   <span className="text-xs font-normal text-gray-900">QTY: {Number(li.quantity).toFixed(0)} {li.unit}</span>
                                   <div className="w-1 h-1 bg-gray-200 rounded-full" />
                                   <span className="text-xs font-light text-[#1B4332]">PO: {li.poNumber || 'N/A'}</span>
                                </div>
                             </div>
                          </div>
                          <div className="text-right">
                             <p className="text-2xl font-light text-gray-900">${Number(li.lineTotal).toFixed(0)}</p>
                             <p className="text-[10px] font-light text-gray-800 uppercase tracking-widest">Extracted Rate: ${li.unitRate}/ton</p>
                          </div>
                       </div>

                       <div className="grid grid-cols-2 gap-6">
                          {/* Ticket Linking */}
                          <div className="bg-gray-50 rounded-[30px] p-6 border-2 border-dashed border-gray-100">
                             <div className="flex items-center justify-between mb-4">
                                <span className="text-[10px] font-light uppercase tracking-widest text-gray-900 flex items-center gap-2">
                                   <Truck className="w-3 h-3" /> Delivery Evidence
                                </span>
                                {li.matchedTickets?.length > 0 && <CheckCircle className="w-4 h-4 text-green-500" />}
                             </div>
                             
                             {li.matchedTickets?.length > 0 ? (
                               <div className="space-y-3">
                                  {li.matchedTickets.map(t => (
                                    <div key={t.id} className="bg-white p-3 rounded-2xl flex items-center gap-3 border shadow-sm group">
                                       <div className="w-10 h-10 rounded-lg overflow-hidden border cursor-pointer" onClick={() => setZoomedImage(getFullUrl(t.imageUrl))}>
                                          <img src={getFullUrl(t.imageUrl)} className="w-full h-full object-cover" alt="Ticket" />
                                       </div>
                                       <div className="flex-1">
                                          <p className="text-[10px] font-normal text-gray-900">T-{t.ticketNumber || t.id.substring(0,6)}</p>
                                          <p className="text-[9px] font-light text-purple-600 uppercase tracking-tighter">{Number(t.quantity)} {t.unit}</p>
                                       </div>
                                       <button className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-red-50 text-red-400 rounded-lg transition-all">
                                          <X className="w-3 h-3" />
                                       </button>
                                    </div>
                                  ))}
                                  <button onClick={() => setLinkingLineItem({ id: li.id, type: 'ticket' })} className="w-full py-2 text-[10px] font-light uppercase text-gray-900 hover:text-green-600 transition-colors">Add Link +</button>
                               </div>
                             ) : (
                               <div className="py-4 text-center">
                                  <AlertTriangle className="w-6 h-6 text-red-200 mx-auto mb-2" />
                                  <button onClick={() => setLinkingLineItem({ id: li.id, type: 'ticket' })} className="text-[10px] font-light uppercase text-[#1B4332] hover:underline underline-offset-4">Manual Ticket Link</button>
                               </div>
                             )}
                          </div>

                          {/* Order Linking */}
                          <div className="bg-gray-50 rounded-[30px] p-6 border-2 border-dashed border-gray-100">
                             <div className="flex items-center justify-between mb-4">
                                <span className="text-[10px] font-light uppercase tracking-widest text-gray-900 flex items-center gap-2">
                                   <ShoppingCart className="w-3 h-3" /> Spruce Order
                                </span>
                                {li.matchedOrderId && <CheckCircle className="w-4 h-4 text-blue-500" />}
                             </div>

                             {li.matchedOrderId ? (
                               <div className="bg-blue-600 rounded-2xl p-4 text-white relative overflow-hidden group">
                                  <div className="relative z-10">
                                     <p className="text-[9px] font-light text-blue-200 uppercase tracking-widest mb-1">Authorization</p>
                                     <p className="text-sm font-light tracking-tight">{li.matchedOrder?.spruceOrderId}</p>
                                     <div className="flex items-center justify-between mt-3">
                                        <span className="text-[10px] font-normal opacity-70">QTY Match</span>
                                        <span className="text-xs font-light">{Number(li.matchedOrder?.quantity)} {li.matchedOrder?.unit}</span>
                                     </div>
                                  </div>
                                  <button className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 p-1 bg-white/10 hover:bg-white/20 rounded-lg transition-all">
                                     <X className="w-3 h-3" />
                                  </button>
                               </div>
                             ) : (
                               <div className="py-4 text-center">
                                  <Package className="w-6 h-6 text-gray-200 mx-auto mb-2" />
                                  <button onClick={() => setLinkingLineItem({ id: li.id, type: 'order' })} className="text-[10px] font-light uppercase text-blue-600 hover:underline underline-offset-4">Find Order Link</button>
                               </div>
                             )}
                          </div>
                       </div>
                    </div>
                  ))}
               </div>
            </div>
          </>
        )}
      </div>

      {/* Manual Link Modal */}
      {linkingLineItem && (
        <div className="fixed inset-0 bg-black/80 z-[100] flex items-center justify-center p-6 backdrop-blur-sm">
           <div className="bg-white w-full max-w-xl rounded-[40px] overflow-hidden shadow-2xl animate-in zoom-in-95 duration-200">
              <div className="p-8 border-b flex items-center justify-between bg-gray-50">
                 <div>
                    <h2 className="text-2xl font-light text-gray-900 tracking-tight">Manual Association</h2>
                    <p className="text-xs font-normal text-gray-900 uppercase mt-1 tracking-widest">Lookup {linkingLineItem.type} in central database</p>
                 </div>
                 <button onClick={() => setLinkingLineItem(null)} className="p-3 hover:bg-gray-200 rounded-2xl transition-all">
                    <X className="w-6 h-6 text-gray-900" />
                 </button>
              </div>
              
              <div className="p-8 space-y-6">
                 <div className="relative">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-800" />
                    <input 
                      type="text" 
                      placeholder={`Search ${linkingLineItem.type}s by number, PO, or material...`}
                      className="w-full pl-12 pr-4 py-4 bg-gray-100 border-none rounded-2xl text-base font-normal focus:ring-4 focus:ring-green-100 outline-none transition-all"
                      onChange={e => searchManualLinks(e.target.value)}
                      autoFocus
                    />
                 </div>

                 <div className="max-h-80 overflow-y-auto space-y-2 pr-2 custom-scrollbar">
                    {searching ? (
                      <Loader message="Searching records..." />
                    ) : searchResults.length === 0 ? (
                      <div className="py-12 text-center text-gray-800">
                         <Search className="w-12 h-12 mx-auto mb-4 opacity-10" />
                         <p className="font-normal text-sm">Type to begin searching</p>
                      </div>
                    ) : (
                      searchResults.map(res => (
                        <button 
                          key={res.id} 
                          onClick={() => linkingLineItem.type === 'order' ? handleLinkOrder(res.id) : handleLinkTickets(res.id)}
                          className="w-full flex items-center justify-between p-5 hover:bg-green-50 rounded-[24px] border border-transparent hover:border-green-100 transition-all text-left"
                        >
                           <div className="flex items-center gap-4">
                              <div className="w-12 h-12 bg-white rounded-xl shadow-sm border flex items-center justify-center">
                                 {linkingLineItem.type === 'order' ? <ShoppingCart className="w-5 h-5 text-blue-500" /> : <Truck className="w-5 h-5 text-purple-500" />}
                              </div>
                              <div>
                                 <p className="text-base font-light text-gray-900">{res.spruceOrderId || res.ticketNumber || res.id.substring(0,8)}</p>
                                 <p className="text-[10px] font-light text-gray-900 uppercase tracking-widest">{res.product || res.material || 'General Material'}</p>
                              </div>
                           </div>
                           <div className="text-right">
                              <p className="text-sm font-light text-gray-900">{res.quantity} {res.unit}</p>
                              <div className="flex items-center gap-1 text-[10px] font-normal text-green-700 uppercase">
                                 PO: {res.poNumber || 'N/A'} <ChevronRight className="w-3 h-3" />
                              </div>
                           </div>
                        </button>
                      ))
                    )}
                 </div>
              </div>
           </div>
        </div>
      )}

      {/* Lightbox */}
      {zoomedImage && (
        <div className="fixed inset-0 bg-black/95 z-[200] flex flex-col p-12 overflow-hidden animate-in fade-in duration-300" onClick={() => setZoomedImage(null)}>
           <button className="absolute top-8 right-8 p-4 bg-white/10 hover:bg-white/20 rounded-full text-white transition-all backdrop-blur-md">
              <X className="w-8 h-8" />
           </button>
           <div className="flex-1 flex items-center justify-center">
              <img 
                src={zoomedImage} 
                className="max-w-full max-h-full object-contain shadow-2xl rounded-lg animate-in zoom-in-95 duration-500" 
                onClick={e => e.stopPropagation()} 
                alt="Document Zoom"
              />
           </div>
           <div className="h-20 flex items-center justify-center gap-8">
              <button className="flex items-center gap-2 text-white/60 hover:text-white font-normal transition-colors">
                 <Search className="w-5 h-5" /> Zoom In
              </button>
              <div className="w-px h-6 bg-white/10" />
              <button className="flex items-center gap-2 text-white/60 hover:text-white font-normal transition-colors">
                 <ExternalLink className="w-5 h-5" /> Open in New Tab
              </button>
           </div>
        </div>
      )}
    </div>
  );
}
function VerificationDeskSkeleton() {
  return (
    <div className="flex h-full bg-[#F3F4F6] -m-8 relative overflow-hidden">
      <SidebarSkeleton />
      <div className="flex-1 flex flex-col bg-gray-100">
        <div className="h-20 bg-white border-b px-8 flex items-center justify-between shadow-sm">
          <div className="flex items-center gap-8">
            <div className="flex flex-col gap-2">
              <Skeleton variant="text" width="60px" height="10px" />
              <Skeleton variant="text" width="120px" height="20px" />
            </div>
            <div className="w-px h-8 bg-gray-200" />
            <div className="flex flex-col gap-2">
              <Skeleton variant="text" width="80px" height="10px" />
              <Skeleton variant="rectangle" width="100px" height="16px" className="rounded-full" />
            </div>
          </div>
          <div className="flex gap-4">
            <Skeleton variant="rectangle" width="140px" height="40px" className="rounded-xl" />
          </div>
        </div>

        <div className="flex-1 flex p-6 gap-6 overflow-hidden">
          <div className="w-[450px] flex flex-col gap-4">
            <Skeleton variant="rectangle" height="600px" className="rounded-[40px]" />
            <Skeleton variant="rectangle" height="150px" className="rounded-[40px]" />
          </div>
          <div className="flex-1 space-y-6">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="bg-white rounded-[40px] p-8 border border-gray-100 shadow-sm space-y-6">
                <div className="flex items-center gap-4">
                  <Skeleton variant="rectangle" width="48px" height="48px" className="rounded-2xl" />
                  <div className="space-y-2">
                    <Skeleton variant="text" width="200px" height="24px" />
                    <Skeleton variant="text" width="150px" height="16px" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-6">
                  <Skeleton variant="rectangle" height="120px" className="rounded-[30px]" />
                  <Skeleton variant="rectangle" height="120px" className="rounded-[30px]" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
