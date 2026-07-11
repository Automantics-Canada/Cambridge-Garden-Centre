import React, { useState, useEffect, useCallback } from 'react';
import api from '../../api/axios';
import { supabase } from '../../supabaseClient';
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
  ExternalLink,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import { SidebarSkeleton, Skeleton } from '../../components/Skeleton';
import Loader from '../../components/Loader';
import toast from 'react-hot-toast';
import { motion, AnimatePresence } from 'framer-motion';

export default function VerificationDesk() {
  const [invoices, setInvoices] = useState([]);
  const [selectedInvoice, setSelectedInvoice] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('ALL');
  const [isProcessing, setIsProcessing] = useState(false);
  const [detailsLoadingId, setDetailsLoadingId] = useState(null);
  
  // Interaction states
  const [zoomedImage, setZoomedImage] = useState(null);
  const [showDisputeInput, setShowDisputeInput] = useState(false);
  const [disputeNote, setDisputeNote] = useState('');
  const [linkingLineItem, setLinkingLineItem] = useState(null); // { id, type: 'order' | 'ticket' }
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  
  // Collapsible sections inside selected invoice
  const [isDocPreviewExpanded, setIsDocPreviewExpanded] = useState(true);
  const [expandedLineItems, setExpandedLineItems] = useState({});

  const fetchInvoices = useCallback(async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const headers = token ? { Authorization: `Bearer ${token}` } : {};

      const { data, error } = await supabase.functions.invoke('fetch-cgc-data?resource=invoices&limit=1000', {
        method: 'GET',
        headers
      });

      if (error) throw error;

      setInvoices(data?.data || []);
      // Auto-select and expand first if none selected
      if (data?.data?.length > 0 && !selectedInvoice) {
        const firstId = data.data[0].id;
        setDetailsLoadingId(firstId);
        await fetchInvoiceDetails(firstId);
      }
    } catch (err) {
      toast.error('Failed to load invoices');
    } finally {
      setLoading(false);
      setDetailsLoadingId(null);
    }
  }, [selectedInvoice]);

  const fetchInvoiceDetails = async (id) => {
    try {
      const token = localStorage.getItem('token');
      const headers = token ? { Authorization: `Bearer ${token}` } : {};

      const { data, error } = await supabase.functions.invoke(`fetch-cgc-data?resource=invoice-details&id=${id}`, {
        method: 'GET',
        headers
      });

      if (error) throw error;

      setSelectedInvoice(data);
      setDisputeNote(data?.disputeNote || '');
      setShowDisputeInput(false);
    } catch (err) {
      toast.error('Failed to load invoice details');
    }
  };

  useEffect(() => {
    fetchInvoices();
  }, []);

  // Auto-expand first line item on select
  useEffect(() => {
    if (selectedInvoice?.lineItems?.length > 0) {
      setExpandedLineItems({ [selectedInvoice.lineItems[0].id]: true });
    } else {
      setExpandedLineItems({});
    }
  }, [selectedInvoice]);

  const handleToggleExpand = async (id) => {
    if (selectedInvoice?.id === id) {
      setSelectedInvoice(null);
    } else {
      setDetailsLoadingId(id);
      try {
        await fetchInvoiceDetails(id);
      } finally {
        setDetailsLoadingId(null);
      }
    }
  };

  const toggleLineItem = (id) => {
    setExpandedLineItems(prev => ({
      ...prev,
      [id]: !prev[id]
    }));
  };

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
    <div className="flex flex-col h-full bg-[#F3F4F6] -m-8 p-8 overflow-y-auto">
      {/* 1. Dashboard Filter & Search Toolbar */}
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 mb-8 bg-white p-6 rounded-[30px] border border-gray-100 shadow-sm">
        <div>
          <h1 className="text-2xl font-light text-gray-900 tracking-tight flex items-center gap-3">
            <FileText className="w-7 h-7 text-[#1B4332]" />
            Match Desk
          </h1>
          <p className="text-xs font-normal text-gray-500 mt-1 uppercase tracking-wider">
            Reconcile invoices, delivery tickets, and orders in a unified dropdown format
          </p>
        </div>
        
        <div className="flex flex-wrap items-center gap-3">
          {/* Search Input */}
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input 
              type="text" 
              placeholder="Search invoices or suppliers..."
              className="w-full pl-10 pr-4 py-2.5 bg-gray-50 border border-gray-100 rounded-xl text-sm focus:ring-2 focus:ring-[#1B4332] outline-none transition-all placeholder-gray-400 font-light"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          {/* Status Filter Tabs */}
          <div className="flex items-center gap-1 bg-gray-100 p-1 rounded-xl w-full sm:w-auto overflow-x-auto">
            {['ALL', 'PENDING_REVIEW', 'VERIFIED', 'DISPUTED'].map((status) => (
              <button
                key={status}
                onClick={() => setFilterStatus(status)}
                className={`px-4 py-2 rounded-lg text-xs font-medium uppercase tracking-wider whitespace-nowrap transition-all ${
                  filterStatus === status 
                    ? 'bg-white text-[#1B4332] shadow-sm font-semibold' 
                    : 'text-gray-500 hover:text-gray-900 hover:bg-white/40'
                }`}
              >
                {status.replace('_', ' ')}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 2. Invoices Dropdown List */}
      <div className="space-y-4">
        {filteredInvoices.length === 0 ? (
          <div className="bg-white rounded-[32px] border border-gray-100 p-12 text-center text-gray-500 shadow-sm">
            <History className="w-16 h-16 mx-auto mb-4 opacity-20 text-[#1B4332]" />
            <p className="text-lg font-light">No invoices found matching your filters</p>
          </div>
        ) : (
          filteredInvoices.map((inv) => {
            const isExpanded = selectedInvoice?.id === inv.id;
            const isDetailLoading = detailsLoadingId === inv.id;

            return (
              <div 
                key={inv.id} 
                className={`bg-white rounded-[32px] border transition-all duration-300 overflow-hidden ${
                  isExpanded 
                    ? 'border-[#1B4332] shadow-xl shadow-green-50/50 ring-1 ring-[#1B4332]' 
                    : 'border-gray-100 hover:border-green-200 hover:shadow-md hover:shadow-gray-100/50 shadow-sm'
                }`}
              >
                {/* Accordion Header Card */}
                <button
                  onClick={() => handleToggleExpand(inv.id)}
                  className="w-full text-left p-6 md:p-8 flex flex-col md:flex-row md:items-center justify-between gap-6 transition-colors hover:bg-gray-50/40"
                >
                  <div className="flex items-center gap-4 flex-1">
                    {/* Status icon */}
                    <div className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-colors ${
                      inv.status === 'VERIFIED' ? 'bg-green-50 text-green-600' :
                      inv.status === 'DISPUTED' ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-600'
                    }`}>
                      {inv.status === 'VERIFIED' ? <CheckCircle className="w-6 h-6" /> :
                       inv.status === 'DISPUTED' ? <AlertTriangle className="w-6 h-6" /> : <AlertCircle className="w-6 h-6" />}
                    </div>
                    <div>
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-semibold tracking-tight text-gray-500">INV-{inv.invoiceNumber}</span>
                        <span className={`text-[10px] font-bold uppercase px-2.5 py-0.5 rounded-full tracking-wider ${
                          inv.status === 'VERIFIED' ? 'bg-green-100 text-green-700' :
                          inv.status === 'DISPUTED' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                        }`}>
                          {inv.status.replace('_', ' ')}
                        </span>
                      </div>
                      <h3 className="text-lg font-medium text-gray-900 mt-1">{inv.supplier?.name}</h3>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-8 md:gap-12">
                    {/* Total Billed */}
                    <div className="flex flex-col">
                      <span className="text-[10px] font-normal uppercase tracking-widest text-gray-400">Total Billed</span>
                      <span className="text-lg font-semibold text-gray-900 mt-0.5">${Number(inv.totalAmount).toLocaleString()}</span>
                    </div>

                    {/* Reconciliation State Badge */}
                    <div className="flex flex-col">
                      <span className="text-[10px] font-normal uppercase tracking-widest text-gray-400">Reconciliation</span>
                      <span className="text-xs font-medium text-gray-600 mt-1.5 flex items-center gap-1.5">
                        <FileText className="w-3.5 h-3.5 text-[#1B4332]" />
                        {isExpanded ? 'Viewing Details' : 'Click to Reconcile'}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center justify-end pl-4">
                    {isDetailLoading ? (
                      <div className="w-6 h-6 border-2 border-t-transparent border-[#1B4332] rounded-full animate-spin" />
                    ) : (
                      <ChevronDown className={`w-6 h-6 text-gray-400 transition-transform duration-300 ${isExpanded ? 'rotate-180 text-[#1B4332]' : ''}`} />
                    )}
                  </div>
                </button>

                {/* Accordion Dropdown Content */}
                <AnimatePresence initial={false}>
                  {isExpanded && selectedInvoice && !isDetailLoading && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.3, ease: 'easeInOut' }}
                      className="overflow-hidden border-t border-gray-100 bg-gray-50/20"
                    >
                      <div className="p-6 md:p-8 space-y-6">
                        {/* 2.1 Dropdown Action Bar */}
                        <div className="bg-white rounded-3xl p-6 border border-gray-100 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-6">
                          <div className="flex items-center gap-8">
                            <div className="flex flex-col">
                              <span className="text-[10px] font-light text-gray-400 uppercase tracking-widest">Supplier Name</span>
                              <span className="text-base font-medium text-gray-900 mt-0.5">{selectedInvoice.supplier?.name}</span>
                            </div>
                            <div className="w-px h-8 bg-gray-200" />
                            <div className="flex flex-col">
                              <span className="text-[10px] font-light text-gray-400 uppercase tracking-widest">Verification Status</span>
                              <div className="flex items-center gap-2 mt-1">
                                <div className={`w-2.5 h-2.5 rounded-full ${selectedInvoice.status === 'VERIFIED' ? 'bg-green-500' : 'bg-yellow-500'} animate-pulse`} />
                                <span className={`text-xs font-semibold uppercase ${selectedInvoice.status === 'VERIFIED' ? 'text-green-700' : 'text-yellow-700'}`}>
                                  {selectedInvoice.status.replace('_', ' ')}
                                </span>
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-3">
                            {selectedInvoice.status === 'PENDING_REVIEW' && (
                              <>
                                <button 
                                  onClick={() => setShowDisputeInput(!showDisputeInput)}
                                  className={`px-6 py-2.5 rounded-xl font-medium text-xs transition-all border ${showDisputeInput ? 'bg-red-500 text-white border-red-500 shadow-sm' : 'bg-white text-red-600 border-red-100 hover:bg-red-50'}`}
                                >
                                  {showDisputeInput ? 'Cancel Dispute' : 'Flag Dispute'}
                                </button>
                                <button 
                                  onClick={handleVerify}
                                  disabled={isProcessing}
                                  className="px-8 py-2.5 bg-[#1B4332] hover:bg-black text-white font-medium text-xs rounded-xl transition-all shadow-lg shadow-green-100 flex items-center gap-2 disabled:opacity-50"
                                >
                                  {isProcessing ? 'Processing...' : <><CheckCircle className="w-4 h-4" /> Final Approve</>}
                                </button>
                              </>
                            )}
                            {selectedInvoice.status !== 'PENDING_REVIEW' && (
                              <button 
                                onClick={() => api.post(`/api/invoices/${selectedInvoice.id}/reopen`).then(() => fetchInvoiceDetails(selectedInvoice.id))}
                                className="px-6 py-2.5 bg-gray-800 text-white rounded-xl font-medium text-xs hover:bg-black transition-all shadow-sm"
                              >
                                Reopen Record
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Dispute Form Inline inside dropdown */}
                        <AnimatePresence>
                          {showDisputeInput && (
                            <motion.div 
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              className="bg-red-600 rounded-3xl p-6 flex flex-col md:flex-row md:items-center gap-6 overflow-hidden shadow-inner"
                            >
                              <AlertTriangle className="w-8 h-8 text-red-100 flex-shrink-0" />
                              <div className="flex-1">
                                <label className="text-[10px] font-semibold text-red-100 uppercase tracking-widest">Why are you disputing this invoice?</label>
                                <input 
                                  type="text" 
                                  placeholder="e.g. Quantity mismatch on gravel line... or Rate doesn't match negotiated..."
                                  className="w-full bg-red-700/50 border-red-400/50 rounded-xl px-4 py-2.5 mt-1.5 text-white placeholder-red-300 outline-none focus:ring-2 focus:ring-white transition-all border text-sm"
                                  value={disputeNote}
                                  onChange={e => setDisputeNote(e.target.value)}
                                  autoFocus
                                />
                              </div>
                              <button 
                                onClick={handleDispute}
                                disabled={isProcessing}
                                className="px-8 py-3 bg-white text-red-600 font-semibold text-xs rounded-xl hover:shadow-xl transition-all disabled:opacity-50 flex-shrink-0 self-end md:self-auto"
                              >
                                {isProcessing ? 'Flagging...' : 'Confirm Dispute'}
                              </button>
                            </motion.div>
                          )}
                        </AnimatePresence>

                        {/* 2.2 Split Layout (Doc Preview + Line Items) */}
                        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                          
                          {/* Left Column: Collapsible Original Invoice Document (Col Span 5) */}
                          <div className="lg:col-span-5 flex flex-col gap-4">
                            <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
                              {/* Document Accordion Header */}
                              <button
                                onClick={() => setIsDocPreviewExpanded(!isDocPreviewExpanded)}
                                className="w-full p-5 flex items-center justify-between border-b border-gray-50 hover:bg-gray-50/50 transition-colors"
                              >
                                <span className="text-xs font-semibold text-gray-800 uppercase tracking-wider flex items-center gap-2">
                                  <FileText className="w-4 h-4 text-[#1B4332]" />
                                  Original Bill Image
                                </span>
                                <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform duration-300 ${isDocPreviewExpanded ? 'rotate-180' : ''}`} />
                              </button>

                              {/* Document Body */}
                              <AnimatePresence initial={false}>
                                {isDocPreviewExpanded && (
                                  <motion.div
                                    initial={{ height: 0, opacity: 0 }}
                                    animate={{ height: 'auto', opacity: 1 }}
                                    exit={{ height: 0, opacity: 0 }}
                                    transition={{ duration: 0.25 }}
                                    className="overflow-hidden"
                                  >
                                    <div className="p-4 bg-gray-50">
                                      <div 
                                        className="aspect-[3/4] rounded-2xl overflow-hidden relative group cursor-pointer border border-gray-200/80 bg-white" 
                                        onClick={() => setZoomedImage(getFullUrl(selectedInvoice.fileUrl))}
                                      >
                                        <img 
                                          src={getFullUrl(selectedInvoice.fileUrl)} 
                                          className="w-full h-full object-cover grayscale-[15%] group-hover:grayscale-0 transition-all duration-500" 
                                          alt="Invoice Scan" 
                                        />
                                        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent flex flex-col justify-end p-6">
                                          <div className="flex items-center justify-between">
                                            <span className="text-white text-[9px] font-semibold uppercase tracking-widest opacity-80">Zoom scan</span>
                                            <Maximize2 className="text-white w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" />
                                          </div>
                                          <h3 className="text-white text-lg font-light mt-1">INV-{selectedInvoice.invoiceNumber}</h3>
                                        </div>
                                      </div>
                                    </div>
                                  </motion.div>
                                )}
                              </AnimatePresence>
                            </div>

                            {/* Summary Totals Card */}
                            <div className="bg-[#1B4332] rounded-3xl p-6 text-white shadow-lg shadow-green-900/10">
                              <h4 className="text-[10px] font-semibold uppercase tracking-widest text-green-300/60 mb-4">Invoice Summary</h4>
                              <div className="space-y-4">
                                <div className="flex items-center justify-between">
                                  <span className="text-sm font-normal opacity-70">Total Billed</span>
                                  <span className="text-xl font-light">${Number(selectedInvoice.totalAmount).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                                </div>
                                <div className="flex items-center justify-between border-t border-green-800 pt-4">
                                  <span className="text-sm font-normal opacity-70 text-green-200">Reconciliation state</span>
                                  <span className="text-xs font-semibold bg-white/10 px-3 py-1 rounded-full uppercase tracking-wider">{selectedInvoice.status}</span>
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Right Column: Line Items nested Accordions (Col Span 7) */}
                          <div className="lg:col-span-7 space-y-4">
                            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-1 pl-1">Line Item Reconciliations</h3>
                            
                            {selectedInvoice.lineItems?.map((li, idx) => {
                              const isLineExpanded = !!expandedLineItems[li.id];

                              return (
                                <div 
                                  key={li.id} 
                                  className={`bg-white rounded-3xl border transition-all ${
                                    isLineExpanded 
                                      ? 'border-[#1B4332]/40 shadow-sm' 
                                      : 'border-gray-100 hover:border-gray-200 shadow-sm hover:shadow'
                                  }`}
                                >
                                  {/* Line Item Accordion Header */}
                                  <button
                                    onClick={() => toggleLineItem(li.id)}
                                    className="w-full text-left p-6 flex items-start justify-between gap-4"
                                  >
                                    <div className="flex items-start gap-4">
                                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-semibold text-xs flex-shrink-0 ${
                                        isLineExpanded ? 'bg-[#1B4332] text-white' : 'bg-gray-50 text-gray-500'
                                      }`}>
                                        {String(idx + 1).padStart(2, '0')}
                                      </div>
                                      <div>
                                        <h4 className="text-base font-semibold text-gray-900 tracking-tight leading-tight">{li.description}</h4>
                                        <div className="flex items-center gap-3 mt-1.5">
                                          <span className="text-xs font-medium text-gray-500">QTY: {Number(li.quantity).toFixed(0)} {li.unit}</span>
                                          <div className="w-1.5 h-1.5 bg-gray-200 rounded-full" />
                                          <span className="text-xs font-semibold text-[#1b4332] bg-green-50 px-2 py-0.5 rounded-full uppercase tracking-wide">PO: {li.poNumber || 'N/A'}</span>
                                        </div>
                                      </div>
                                    </div>

                                    <div className="flex items-center gap-4">
                                      <div className="text-right flex-shrink-0">
                                        <p className="text-lg font-bold text-gray-950">${Number(li.lineTotal).toFixed(2)}</p>
                                        
                                        {li.approvedTotal && (
                                          <div className="mt-1 flex items-center justify-end gap-1.5">
                                            {Number(li.lineTotal) - Number(li.approvedTotal) !== 0 ? (
                                              <span className="text-[10px] font-bold text-red-600 bg-red-50 px-1.5 py-0.5 rounded uppercase">Discrepancy</span>
                                            ) : (
                                              <span className="text-[10px] font-bold text-green-700 bg-green-50 px-1.5 py-0.5 rounded uppercase">Matched</span>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                      <ChevronDown className={`w-5 h-5 text-gray-400 transition-transform duration-200 ${isLineExpanded ? 'rotate-180 text-[#1B4332]' : ''}`} />
                                    </div>
                                  </button>

                                  {/* Line Item Accordion Nested Body */}
                                  <AnimatePresence initial={false}>
                                    {isLineExpanded && (
                                      <motion.div
                                        initial={{ height: 0, opacity: 0 }}
                                        animate={{ height: 'auto', opacity: 1 }}
                                        exit={{ height: 0, opacity: 0 }}
                                        transition={{ duration: 0.25, ease: 'easeInOut' }}
                                        className="overflow-hidden border-t border-gray-50 bg-gray-50/10"
                                      >
                                        <div className="p-6 space-y-6">
                                          {/* Discrepancy analysis summary inside dropdown */}
                                          {li.approvedTotal && (
                                            <div className="bg-gray-50 rounded-2xl p-4 border border-gray-100 flex flex-col sm:flex-row justify-between gap-3 text-xs">
                                              <div className="space-y-1">
                                                <p className="text-gray-500 font-light uppercase tracking-wider">Calculation Details</p>
                                                <p className="font-semibold text-gray-800">
                                                  Approved rate: ${Number(li.negotiatedRate).toFixed(2)} / {li.unit} + 13% HST
                                                </p>
                                              </div>
                                              <div className="text-left sm:text-right space-y-0.5 flex-shrink-0">
                                                <div className="flex items-center sm:justify-end gap-2">
                                                  <span className="text-gray-500">Approved Total:</span>
                                                  <span className="font-bold text-green-700">${Number(li.approvedTotal).toFixed(2)}</span>
                                                </div>
                                                <div className="flex items-center sm:justify-end gap-2">
                                                  <span className="text-gray-500">Discrepancy:</span>
                                                  <span className={`font-bold ${Number(li.lineTotal) - Number(li.approvedTotal) !== 0 ? 'text-red-600' : 'text-green-700'}`}>
                                                    ${(Number(li.lineTotal) - Number(li.approvedTotal)).toFixed(2)}
                                                  </span>
                                                </div>
                                              </div>
                                            </div>
                                          )}

                                          {/* Ticket and Order Matching Grid */}
                                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            
                                            {/* Ticket / Delivery Evidence */}
                                            <div className="bg-white rounded-2xl p-5 border border-gray-100 shadow-sm flex flex-col">
                                              <div className="flex items-center justify-between mb-4 flex-shrink-0">
                                                <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-800 flex items-center gap-1.5">
                                                  <Truck className="w-3.5 h-3.5 text-purple-600" /> Delivery Evidence
                                                </span>
                                                {li.matchedTickets?.length > 0 && <CheckCircle className="w-4 h-4 text-green-500" />}
                                              </div>
                                              
                                              <div className="flex-1">
                                                {li.matchedTickets?.length > 0 ? (
                                                  <div className="space-y-2">
                                                    {li.matchedTickets.map(t => (
                                                      <div key={t.id} className="bg-gray-50 p-2.5 rounded-xl flex items-center gap-3 border border-gray-100 group">
                                                        <div 
                                                          className="w-10 h-10 rounded-lg overflow-hidden border border-gray-200 cursor-pointer flex-shrink-0 bg-white" 
                                                          onClick={() => setZoomedImage(getFullUrl(t.imageUrl))}
                                                        >
                                                          <img src={getFullUrl(t.imageUrl)} className="w-full h-full object-cover" alt="Ticket Scan" />
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                          <div className="flex items-center gap-1.5">
                                                            <p className="text-[10px] font-semibold text-gray-800 truncate">T-{t.ticketNumber || t.id.substring(0,6)}</p>
                                                            {t.spruceMatched && (
                                                              <span className="bg-green-100 text-green-700 px-1 py-0.2 rounded text-[7px] font-extrabold tracking-widest flex items-center gap-0.5"><CheckCircle className="w-2 h-2"/> MATCHED</span>
                                                            )}
                                                          </div>
                                                          <p className="text-[9px] font-bold text-purple-600 uppercase mt-0.5">{Number(t.quantity)} {t.unit}</p>
                                                        </div>
                                                        <button className="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-50 text-red-400 rounded-lg transition-all flex-shrink-0">
                                                          <X className="w-3 h-3" />
                                                        </button>
                                                      </div>
                                                    ))}
                                                    <button 
                                                      onClick={() => setLinkingLineItem({ id: li.id, type: 'ticket' })} 
                                                      className="w-full mt-1.5 py-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500 hover:text-[#1B4332] transition-colors border border-dashed border-gray-200 hover:border-green-300 rounded-xl"
                                                    >
                                                      Add Link +
                                                    </button>
                                                  </div>
                                                ) : (
                                                  <div className="py-6 text-center bg-gray-50/50 rounded-2xl border-2 border-dashed border-gray-100">
                                                    <AlertTriangle className="w-6 h-6 text-amber-300 mx-auto mb-2" />
                                                    <button 
                                                      onClick={() => setLinkingLineItem({ id: li.id, type: 'ticket' })} 
                                                      className="text-[10px] font-semibold uppercase tracking-wider text-[#1B4332] hover:underline underline-offset-4"
                                                    >
                                                      Manual Ticket Link
                                                    </button>
                                                  </div>
                                                )}
                                              </div>
                                            </div>

                                            {/* Spruce Order Card */}
                                            <div className="bg-white rounded-2xl p-5 border border-gray-100 shadow-sm flex flex-col">
                                              <div className="flex items-center justify-between mb-4 flex-shrink-0">
                                                <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-800 flex items-center gap-1.5">
                                                  <ShoppingCart className="w-3.5 h-3.5 text-blue-600" /> Spruce Order
                                                </span>
                                                {li.matchedOrderId && <CheckCircle className="w-4 h-4 text-blue-500" />}
                                              </div>

                                              <div className="flex-1">
                                                {li.matchedOrderId ? (
                                                  <div className="space-y-3">
                                                    <div className="bg-blue-600 rounded-xl p-4 text-white relative overflow-hidden group shadow-sm">
                                                      <div className="relative z-10">
                                                        <p className="text-[8px] font-bold text-blue-200 uppercase tracking-widest mb-0.5">Authorization ID</p>
                                                        <p className="text-sm font-semibold tracking-tight">{li.matchedOrder?.spruceOrderId}</p>
                                                        <div className="flex items-center justify-between mt-3 border-t border-white/10 pt-2 text-[10px]">
                                                          <span className="opacity-75">Order Qty</span>
                                                          <span className="font-bold">{Number(li.matchedOrder?.quantity)} {li.matchedOrder?.unit}</span>
                                                        </div>
                                                      </div>
                                                      <button className="absolute top-2.5 right-2.5 opacity-0 group-hover:opacity-100 p-1 bg-white/10 hover:bg-white/20 rounded-lg transition-all">
                                                        <X className="w-3 h-3 text-white" />
                                                      </button>
                                                    </div>
                                                    
                                                    {/* Delivery Driver Sub Details */}
                                                    {li.matchedOrder?.deliveries?.map(del => (
                                                      <div key={del.id} className="bg-gray-50 rounded-xl p-3 border border-gray-100 space-y-2">
                                                        <div className="flex justify-between items-center">
                                                          <div className="flex items-center gap-1.5">
                                                            <Truck className="w-3.5 h-3.5 text-gray-400" />
                                                            <span className="text-[10px] font-bold text-gray-800 truncate">{del.driver?.name || 'Unassigned'}</span>
                                                          </div>
                                                          <span className={`text-[8px] font-black px-2 py-0.5 rounded-full uppercase tracking-wider ${del.status === 'DELIVERED' ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-600'}`}>
                                                            {del.status.replace('_', ' ')}
                                                          </span>
                                                        </div>
                                                        <div className="grid grid-cols-2 gap-2">
                                                          <div className="border border-gray-200 rounded-lg overflow-hidden group/img relative bg-white aspect-video flex flex-col justify-end">
                                                            {del.pickupPhotoUrl ? (
                                                              <img src={getFullUrl(del.pickupPhotoUrl)} className="absolute inset-0 w-full h-full object-cover cursor-pointer hover:opacity-90 transition-opacity" alt="Pickup Photo" onClick={() => setZoomedImage(getFullUrl(del.pickupPhotoUrl))} />
                                                            ) : (
                                                              <span className="text-[8px] text-gray-400 absolute inset-0 flex items-center justify-center font-semibold text-center leading-none p-1">No Photo</span>
                                                            )}
                                                            <div className="bg-black/40 p-1 relative z-10"><p className="text-[7px] text-white font-extrabold uppercase tracking-widest text-center">Pickup</p></div>
                                                          </div>
                                                          <div className="border border-gray-200 rounded-lg overflow-hidden group/img relative bg-white aspect-video flex flex-col justify-end">
                                                            {del.deliveryPhotoUrl ? (
                                                              <img src={getFullUrl(del.deliveryPhotoUrl)} className="absolute inset-0 w-full h-full object-cover cursor-pointer hover:opacity-90 transition-opacity" alt="Delivery Photo" onClick={() => setZoomedImage(getFullUrl(del.deliveryPhotoUrl))} />
                                                            ) : (
                                                              <span className="text-[8px] text-gray-400 absolute inset-0 flex items-center justify-center font-semibold text-center leading-none p-1">No Photo</span>
                                                            )}
                                                            <div className="bg-black/40 p-1 relative z-10"><p className="text-[7px] text-white font-extrabold uppercase tracking-widest text-center">Delivery</p></div>
                                                          </div>
                                                        </div>
                                                      </div>
                                                    ))}
                                                  </div>
                                                ) : (
                                                  <div className="py-6 text-center bg-gray-50/50 rounded-2xl border-2 border-dashed border-gray-100">
                                                    <Package className="w-6 h-6 text-gray-300 mx-auto mb-2" />
                                                    <button 
                                                      onClick={() => setLinkingLineItem({ id: li.id, type: 'order' })} 
                                                      className="text-[10px] font-semibold uppercase tracking-wider text-blue-600 hover:underline underline-offset-4"
                                                    >
                                                      Find Order Link
                                                    </button>
                                                  </div>
                                                )}
                                              </div>
                                            </div>

                                          </div>
                                        </div>
                                      </motion.div>
                                    )}
                                  </AnimatePresence>
                                </div>
                              );
                            })}
                          </div>

                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

              </div>
            );
          })
        )}
      </div>

      {/* 3. Manual Link Search Overlay Modal */}
      {linkingLineItem && (
        <div className="fixed inset-0 bg-black/75 z-[100] flex items-center justify-center p-6 backdrop-blur-sm">
          <div className="bg-white w-full max-w-xl rounded-[40px] overflow-hidden shadow-2xl animate-in zoom-in-95 duration-200">
            <div className="p-8 border-b border-gray-100 flex items-center justify-between bg-gray-50">
              <div>
                <h2 className="text-2xl font-light text-gray-900 tracking-tight">Manual Association</h2>
                <p className="text-xs font-semibold text-[#1B4332] uppercase mt-1.5 tracking-wider">Lookup {linkingLineItem.type} in central database</p>
              </div>
              <button onClick={() => setLinkingLineItem(null)} className="p-3 hover:bg-gray-200 rounded-2xl transition-all">
                <X className="w-6 h-6 text-gray-900" />
              </button>
            </div>
            
            <div className="p-8 space-y-6">
              <div className="relative">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input 
                  type="text" 
                  placeholder={`Search ${linkingLineItem.type}s by code, PO, or material...`}
                  className="w-full pl-12 pr-4 py-4 bg-gray-50 border border-gray-100 rounded-2xl text-base font-light focus:ring-4 focus:ring-green-100 outline-none transition-all placeholder-gray-400"
                  onChange={e => searchManualLinks(e.target.value)}
                  autoFocus
                />
              </div>

              <div className="max-h-80 overflow-y-auto space-y-2 pr-2 custom-scrollbar">
                {searching ? (
                  <Loader message="Searching records..." />
                ) : searchResults.length === 0 ? (
                  <div className="py-12 text-center text-gray-400">
                    <Search className="w-12 h-12 mx-auto mb-4 opacity-20" />
                    <p className="font-light text-sm">Type to begin searching</p>
                  </div>
                ) : (
                  searchResults.map(res => (
                    <button 
                      key={res.id} 
                      onClick={() => linkingLineItem.type === 'order' ? handleLinkOrder(res.id) : handleLinkTickets(res.id)}
                      className="w-full flex items-center justify-between p-5 hover:bg-green-50/50 rounded-[24px] border border-transparent hover:border-green-200/50 transition-all text-left"
                    >
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 bg-white rounded-xl shadow-sm border border-gray-100 flex items-center justify-center">
                          {linkingLineItem.type === 'order' ? <ShoppingCart className="w-5 h-5 text-blue-500" /> : <Truck className="w-5 h-5 text-purple-500" />}
                        </div>
                        <div>
                          <p className="text-base font-semibold text-gray-905 leading-none">{res.spruceOrderId || res.ticketNumber || res.id.substring(0,8)}</p>
                          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mt-1.5">{res.product || res.material || 'General Material'}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold text-gray-900">{res.quantity} {res.unit}</p>
                        <div className="flex items-center gap-1 text-[10px] font-bold text-[#1B4332] uppercase mt-1">
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

      {/* 4. Fullscreen Zoom Image Lightbox */}
      {zoomedImage && (
        <div className="fixed inset-0 bg-black/95 z-[200] flex flex-col pt-12 pb-6 px-4 sm:px-12 animate-in fade-in duration-300" onClick={() => setZoomedImage(null)}>
          <button className="absolute top-4 right-4 sm:top-8 sm:right-8 z-10 p-3 sm:p-4 bg-white/10 hover:bg-white/20 rounded-full text-white transition-all backdrop-blur-md">
            <X className="w-6 h-6 sm:w-8 sm:h-8" />
          </button>
          <div className="flex-1 overflow-y-auto overflow-x-hidden flex justify-center custom-scrollbar rounded-lg">
            <img 
              src={zoomedImage} 
              className="w-full max-w-5xl h-auto shadow-2xl rounded-lg animate-in zoom-in-95 duration-500 my-auto" 
              onClick={e => e.stopPropagation()} 
              alt="Expanded Preview"
            />
          </div>
          <div className="h-16 sm:h-20 flex-shrink-0 flex items-center justify-center gap-8 mt-4">
            <a 
              href={zoomedImage} 
              target="_blank" 
              rel="noreferrer"
              onClick={e => e.stopPropagation()}
              className="flex items-center gap-2 text-white/60 hover:text-white font-medium text-xs uppercase tracking-wider transition-colors bg-white/5 hover:bg-white/10 px-4 py-2 rounded-lg"
            >
              <ExternalLink className="w-4 h-4" /> Open in New Tab
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function VerificationDeskSkeleton() {
  return (
    <div className="flex flex-col h-full bg-[#F3F4F6] -m-8 p-8 overflow-y-auto">
      {/* Skeleton Header Toolbar */}
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 mb-8 bg-white p-6 rounded-[30px] border border-gray-100 shadow-sm animate-pulse">
        <div className="space-y-2">
          <Skeleton variant="text" width="180px" height="28px" />
          <Skeleton variant="text" width="320px" height="16px" />
        </div>
        <div className="flex items-center gap-3">
          <Skeleton variant="rectangle" width="240px" height="42px" className="rounded-xl" />
          <Skeleton variant="rectangle" width="300px" height="42px" className="rounded-xl" />
        </div>
      </div>

      {/* Skeleton List of Invoice Accordions */}
      <div className="space-y-4 animate-pulse">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="bg-white rounded-[32px] border border-gray-100 p-6 md:p-8 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div className="flex items-center gap-4 flex-1">
              <Skeleton variant="rectangle" width="48px" height="48px" className="rounded-2xl" />
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <Skeleton variant="text" width="80px" height="16px" />
                  <Skeleton variant="rectangle" width="100px" height="16px" className="rounded-full" />
                </div>
                <Skeleton variant="text" width="220px" height="24px" />
              </div>
            </div>
            <div className="flex items-center gap-8 md:gap-12">
              <div className="space-y-1">
                <Skeleton variant="text" width="60px" height="12px" />
                <Skeleton variant="text" width="90px" height="20px" />
              </div>
              <div className="space-y-1">
                <Skeleton variant="text" width="60px" height="12px" />
                <Skeleton variant="text" width="90px" height="20px" />
              </div>
            </div>
            <div className="pl-4">
              <Skeleton variant="circle" width="24px" height="24px" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
