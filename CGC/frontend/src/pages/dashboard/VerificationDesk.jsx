import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
  ChevronLeft,
  ExternalLink,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import { SidebarSkeleton, Skeleton } from '../../components/Skeleton';
import Loader from '../../components/Loader';
import toast from 'react-hot-toast';
import { motion, AnimatePresence } from 'framer-motion';
import { ticketThumbnailSrc } from '../../utils/ticketImage';
import { EmptyState, PageHeader, StatusBadge } from '../../components/ui';

const INVOICES_PER_PAGE = 25;

export default function VerificationDesk() {
  const [invoices, setInvoices] = useState([]);
  const [selectedInvoice, setSelectedInvoice] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('ALL');
  const [page, setPage] = useState(1);
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
      const response = await api.get('/api/invoices');
      const nextInvoices = Array.isArray(response.data) ? response.data : [];
      setInvoices(nextInvoices);
      setSelectedInvoice(current => (
        current && nextInvoices.some(invoice => invoice.id === current.id) ? current : null
      ));
    } catch {
      toast.error('Failed to load invoices');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchInvoiceDetails = async (id) => {
    try {
      const response = await api.get(`/api/invoices/${id}`);
      const data = response.data;

      setSelectedInvoice(data);
      setDisputeNote(data?.disputeNote || '');
      setShowDisputeInput(false);
    } catch {
      toast.error('Failed to load invoice details');
    }
  };

  useEffect(() => {
    fetchInvoices();
  }, [fetchInvoices]);

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
    } catch {
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
    } catch {
      toast.error('Ticket linking failed');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleUnlinkOrder = async (lineItemId) => {
    setIsProcessing(true);
    try {
      await api.post('/api/invoices/line-items/unlink-order', {
        lineItemId
      });
      toast.success('Order unlinked successfully');
      fetchInvoiceDetails(selectedInvoice.id);
    } catch {
      toast.error('Failed to unlink order');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleUnlinkTicket = async (lineItemId, ticketId) => {
    setIsProcessing(true);
    try {
      await api.post('/api/invoices/line-items/unlink-ticket', {
        lineItemId,
        ticketId
      });
      toast.success('Ticket unlinked successfully');
      fetchInvoiceDetails(selectedInvoice.id);
    } catch {
      toast.error('Failed to unlink ticket');
    } finally {
      setIsProcessing(false);
    }
  };

  const manualSearchTimeoutRef = useRef(null);

  const searchManualLinks = async (query) => {
    if (manualSearchTimeoutRef.current) {
      clearTimeout(manualSearchTimeoutRef.current);
    }

    if (!query) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    manualSearchTimeoutRef.current = setTimeout(async () => {
      try {
        const endpoint = linkingLineItem.type === 'order' ? '/api/orders' : '/api/tickets';
        const res = await api.get(endpoint, { params: { search: query } });
        setSearchResults(res.data?.data || res.data || []);
      } catch (err) {
        console.error('Search error', err);
      } finally {
        setSearching(false);
      }
    }, 300);
  };

  const filteredInvoices = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return invoices.filter(invoice => {
      const matchesStatus = filterStatus === 'ALL' || invoice.status === filterStatus;
      const matchesSearch = !normalizedSearch
        || invoice.invoiceNumber?.toLowerCase().includes(normalizedSearch)
        || invoice.supplier?.name?.toLowerCase().includes(normalizedSearch)
        || invoice.emailFrom?.toLowerCase().includes(normalizedSearch);
      return matchesStatus && matchesSearch;
    });
  }, [filterStatus, invoices, search]);

  const totalPages = Math.max(Math.ceil(filteredInvoices.length / INVOICES_PER_PAGE), 1);
  const visibleInvoices = filteredInvoices.slice(
    (page - 1) * INVOICES_PER_PAGE,
    page * INVOICES_PER_PAGE,
  );

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  if (loading && invoices.length === 0) return <VerificationDeskSkeleton />;

  const getFullUrl = (url) => {
    if (!url) return '';
    return url.startsWith('http') ? url : `https://cambridge-garden-centre-1.onrender.com${url}`;
  };

  return (
    <div className="flex flex-col h-full bg-canvas -m-8 p-8 overflow-y-auto">
      {/* 1. Dashboard Filter & Search Toolbar */}
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 mb-8 bg-surface p-6 rounded-card border border-line shadow-card">
        <PageHeader
          title="Verification desk"
          subtitle="Open an invoice, check the tickets and orders against it, then verify or dispute."
        />
        
        <div className="flex flex-wrap items-center gap-3">
          {/* Search Input */}
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
            <input 
              type="text" 
              placeholder="Search invoices or suppliers..."
              className="w-full pl-10 pr-4 py-2.5 bg-ink/[0.03] border border-line rounded-control text-sm focus:ring-2 focus:ring-brand outline-none transition-all placeholder:text-muted font-light"
              value={search}
              onChange={e => {
                setPage(1);
                setSearch(e.target.value);
              }}
            />
          </div>

          {/* Status Filter Tabs */}
          <div className="flex items-center gap-1 bg-ink/[0.06] p-1 rounded-control w-full sm:w-auto overflow-x-auto">
            {['ALL', 'PENDING_REVIEW', 'VERIFIED', 'DISPUTED'].map((status) => (
              <button
                key={status}
                onClick={() => {
                  setPage(1);
                  setFilterStatus(status);
                }}
                className={`px-4 py-2 rounded-control text-[12.5px] font-medium whitespace-nowrap transition-all ${
                  filterStatus === status 
                    ? 'bg-surface text-brand shadow-card font-semibold' 
                    : 'text-muted hover:text-ink hover:bg-surface/40'
                }`}
              >
                {status === 'ALL' ? 'All' : status === 'PENDING_REVIEW' ? 'Pending review' : status === 'VERIFIED' ? 'Verified' : 'Disputed'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 2. Invoices Dropdown List */}
      <div className="space-y-4">
        {visibleInvoices.length === 0 ? (
          <EmptyState
            icon={History}
            title="No invoices match"
            message="Try another status or search. Invoices appear here once they have been received."
          />
        ) : (
          visibleInvoices.map((inv) => {
            const isExpanded = selectedInvoice?.id === inv.id;
            const isDetailLoading = detailsLoadingId === inv.id;

            return (
              <div 
                key={inv.id} 
                className={`bg-surface rounded-card border transition-all duration-300 overflow-hidden ${
                  isExpanded 
                    ? 'border-brand shadow-card ring-1 ring-brand' 
                    : 'border-line hover:border-brand/30 hover:shadow-lift shadow-card'
                }`}
              >
                {/* Accordion Header Card */}
                <button
                  onClick={() => handleToggleExpand(inv.id)}
                  className="w-full text-left p-6 md:p-8 flex flex-col md:flex-row md:items-center justify-between gap-6 transition-colors hover:bg-brand/[0.04]"
                >
                  <div className="flex items-center gap-4 flex-1">
                    {/* Status icon */}
                    <div className={`w-12 h-12 rounded-card flex items-center justify-center transition-colors ${
                      inv.status === 'VERIFIED' ? 'bg-brand/10 text-brand' :
                      inv.status === 'DISPUTED' ? 'bg-clay/14 text-clay' : 'bg-ochre/15 text-ochre'
                    }`}>
                      {inv.status === 'VERIFIED' ? <CheckCircle className="w-6 h-6" /> :
                       inv.status === 'DISPUTED' ? <AlertTriangle className="w-6 h-6" /> : <AlertCircle className="w-6 h-6" />}
                    </div>
                    <div>
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-semibold tracking-tight text-muted">INV-{inv.invoiceNumber}</span>
                        <StatusBadge status={inv.status} />
                      </div>
                      <h3 className="text-lg font-medium text-ink mt-1">{inv.supplier?.name}</h3>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-8 md:gap-12">
                    {/* Total Billed */}
                    <div className="flex flex-col">
                      <span className="text-[12.5px] font-normal text-muted">Total Billed</span>
                      <span className="text-lg font-semibold text-ink mt-0.5">${Number(inv.totalAmount).toLocaleString()}</span>
                    </div>

                    {/* Reconciliation State Badge */}
                    <div className="flex flex-col">
                      <span className="text-[12.5px] font-normal text-muted">Reconciliation</span>
                      <span className="text-[12.5px] font-medium text-muted mt-1.5 flex items-center gap-1.5">
                        <FileText className="w-3.5 h-3.5 text-brand" />
                        {isExpanded ? 'Viewing Details' : 'Click to Reconcile'}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center justify-end pl-4">
                    {isDetailLoading ? (
                      <div className="w-6 h-6 border-2 border-t-transparent border-brand rounded-full animate-spin" />
                    ) : (
                      <ChevronDown className={`w-6 h-6 text-muted transition-transform duration-300 ${isExpanded ? 'rotate-180 text-brand' : ''}`} />
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
                      className="overflow-hidden border-t border-line bg-ink/[0.02]"
                    >
                      <div className="p-6 md:p-8 space-y-6">
                        {/* 2.1 Dropdown Action Bar */}
                        <div className="bg-surface rounded-card p-6 border border-line shadow-card flex flex-col md:flex-row md:items-center justify-between gap-6">
                          <div className="flex items-center gap-8">
                            <div className="flex flex-col">
                              <span className="text-[12.5px] font-light text-muted">Supplier Name</span>
                              <span className="text-base font-medium text-ink mt-0.5">{selectedInvoice.supplier?.name}</span>
                            </div>
                            <div className="w-px h-8 bg-ink/[0.08]" />
                            <div className="flex flex-col">
                              <span className="text-[12.5px] font-light text-muted">Verification Status</span>
                              <div className="flex items-center gap-2 mt-1">
                                <div className={`w-2.5 h-2.5 rounded-full ${selectedInvoice.status === 'VERIFIED' ? 'bg-brand' : 'bg-ochre'} animate-pulse`} />
                                <StatusBadge status={selectedInvoice.status} />
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-3">
                            {selectedInvoice.status === 'PENDING_REVIEW' && (
                              <>
                                <button 
                                  onClick={() => setShowDisputeInput(!showDisputeInput)}
                                  className={`px-6 py-2.5 rounded-control font-medium text-[12.5px] transition-all border ${showDisputeInput ? 'bg-clay text-on-clay border-clay shadow-card' : 'bg-surface text-clay border-clay/30 hover:bg-clay/10'}`}
                                >
                                  {showDisputeInput ? 'Cancel Dispute' : 'Flag Dispute'}
                                </button>
                                <button 
                                  onClick={handleVerify}
                                  disabled={isProcessing}
                                  className="px-8 py-2.5 bg-brand hover:brightness-110 text-on-brand font-medium text-[12.5px] rounded-control transition-all shadow-card flex items-center gap-2 disabled:opacity-50"
                                >
                                  {isProcessing ? 'Processing...' : <><CheckCircle className="w-4 h-4" /> Final Approve</>}
                                </button>
                              </>
                            )}
                            {/* {selectedInvoice.status !== 'PENDING_REVIEW' && (
                              // <button 
                              //   onClick={() => api.post(`/api/invoices/${selectedInvoice.id}/reopen`).then(() => fetchInvoiceDetails(selectedInvoice.id))}
                              //   className="px-6 py-2.5 bg-ink text-on-brand rounded-control font-medium text-[12.5px] hover:brightness-110 transition-all shadow-card"
                              // >
                              //   Reopen Record
                              // </button>
                            )} */}
                          </div>
                        </div>

                        {/* Dispute Form Inline inside dropdown */}
                        <AnimatePresence>
                          {showDisputeInput && (
                            <motion.div 
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              className="bg-clay rounded-card p-6 flex flex-col md:flex-row md:items-center gap-6 overflow-hidden shadow-inner"
                            >
                              <AlertTriangle className="w-8 h-8 text-on-clay flex-shrink-0" />
                              <div className="flex-1">
                                <label className="text-[12.5px] font-semibold text-on-clay">Why are you disputing this invoice?</label>
                                <input 
                                  type="text" 
                                  placeholder="e.g. Quantity mismatch on gravel line... or Rate doesn't match negotiated..."
                                  className="w-full bg-clay/50 border-clay/40 rounded-control px-4 py-2.5 mt-1.5 text-on-clay placeholder:text-on-clay/70 outline-none focus:ring-2 focus:ring-brand transition-all border text-sm"
                                  value={disputeNote}
                                  onChange={e => setDisputeNote(e.target.value)}
                                  autoFocus
                                />
                              </div>
                              <button 
                                onClick={handleDispute}
                                disabled={isProcessing}
                                className="px-8 py-3 bg-surface text-clay font-semibold text-[12.5px] rounded-control hover:shadow-card transition-all disabled:opacity-50 flex-shrink-0 self-end md:self-auto"
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
                            <div className="bg-surface rounded-card shadow-card border border-line overflow-hidden">
                              {/* Document Accordion Header */}
                              <button
                                onClick={() => setIsDocPreviewExpanded(!isDocPreviewExpanded)}
                                className="w-full p-5 flex items-center justify-between border-b border-line hover:bg-brand/[0.04] transition-colors"
                              >
                                <span className="text-[12.5px] font-semibold text-ink flex items-center gap-2">
                                  <FileText className="w-4 h-4 text-brand" />
                                  Original Bill Image
                                </span>
                                <ChevronDown className={`w-4 h-4 text-muted transition-transform duration-300 ${isDocPreviewExpanded ? 'rotate-180' : ''}`} />
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
                                    <div className="p-4 bg-ink/[0.03]">
                                      <div 
                                        className="aspect-[3/4] rounded-card overflow-hidden relative group cursor-pointer border border-line/80 bg-surface" 
                                        onClick={() => setZoomedImage(getFullUrl(selectedInvoice.fileUrl))}
                                      >
                                        <img 
                                          src={getFullUrl(selectedInvoice.fileUrl)} 
                                          className="w-full h-full object-cover grayscale-[15%] group-hover:grayscale-0 transition-all duration-500" 
                                          alt="Invoice Scan" 
                                        />
                                        <div className="absolute inset-0 bg-gradient-to-t from-scrim/60 via-transparent to-transparent flex flex-col justify-end p-6">
                                          <div className="flex items-center justify-between">
                                            <span className="text-on-brand text-[12.5px] font-semibold opacity-80">Zoom scan</span>
                                            <Maximize2 className="text-on-brand w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" />
                                          </div>
                                          <h3 className="text-on-brand text-lg font-light mt-1">INV-{selectedInvoice.invoiceNumber}</h3>
                                        </div>
                                      </div>
                                    </div>
                                  </motion.div>
                                )}
                              </AnimatePresence>
                            </div>

                            {/* Summary Totals Card */}
                            <div className="bg-brand rounded-card p-6 text-on-brand shadow-card">
                              <h4 className="text-[12.5px] font-semibold text-on-brand/60 mb-4">Invoice Summary</h4>
                              <div className="space-y-4">
                                <div className="flex items-center justify-between">
                                  <span className="text-sm font-normal opacity-70">Total Billed</span>
                                  <span className="text-xl font-light">${Number(selectedInvoice.totalAmount).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                                </div>
                                <div className="flex items-center justify-between border-t border-brand/40 pt-4">
                                  <span className="text-sm font-normal opacity-70 text-on-brand">Reconciliation state</span>
                                  <span className="text-[12.5px] font-semibold bg-surface/10 px-3 py-1 rounded-full">{selectedInvoice.status}</span>
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Right Column: Line Items nested Accordions (Col Span 7) */}
                          <div className="lg:col-span-7 space-y-4">
                            <h3 className="text-[12.5px] font-semibold text-muted mb-1 pl-1">Line Item Reconciliations</h3>
                            
                            {selectedInvoice.lineItems?.map((li, idx) => {
                              const isLineExpanded = !!expandedLineItems[li.id];

                              return (
                                <div 
                                  key={li.id} 
                                  className={`bg-surface rounded-card border transition-all ${
                                    isLineExpanded 
                                      ? 'border-brand/40 shadow-card' 
                                      : 'border-line hover:border-line shadow-card hover:shadow'
                                  }`}
                                >
                                  {/* Line Item Accordion Header */}
                                  <button
                                    onClick={() => toggleLineItem(li.id)}
                                    className="w-full text-left p-6 flex items-start justify-between gap-4"
                                  >
                                    <div className="flex items-start gap-4">
                                      <div className={`w-10 h-10 rounded-control flex items-center justify-center font-semibold text-[12.5px] flex-shrink-0 ${
                                        isLineExpanded ? 'bg-brand text-on-brand' : 'bg-ink/[0.03] text-muted'
                                      }`}>
                                        {String(idx + 1).padStart(2, '0')}
                                      </div>
                                      <div>
                                        <h4 className="text-base font-semibold text-ink tracking-tight leading-tight">{li.description}</h4>
                                        <div className="flex items-center gap-3 mt-1.5">
                                          <span className="text-[12.5px] font-medium text-muted">QTY: {Number(li.quantity).toFixed(0)} {li.unit}</span>
                                          <div className="w-1.5 h-1.5 bg-ink/[0.08] rounded-full" />
                                          <span className="text-[12.5px] font-semibold text-brand bg-brand/10 px-2 py-0.5 rounded-full">PO: {li.poNumber || 'N/A'}</span>
                                        </div>
                                      </div>
                                    </div>

                                    <div className="flex items-center gap-4">
                                      <div className="text-right flex-shrink-0">
                                        <p className="text-lg font-bold text-ink">${Number(li.lineTotal).toFixed(2)}</p>
                                        
                                        {li.approvedTotal && (
                                          <div className="mt-1 flex items-center justify-end gap-1.5">
                                            {Number(li.lineTotal) - Number(li.approvedTotal) !== 0 ? (
                                              <span className="text-[12.5px] font-bold text-clay bg-clay/14 px-1.5 py-0.5 rounded">Discrepancy</span>
                                            ) : (
                                              <span className="text-[12.5px] font-bold text-brand bg-brand/10 px-1.5 py-0.5 rounded">Matched</span>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                      <ChevronDown className={`w-5 h-5 text-muted transition-transform duration-200 ${isLineExpanded ? 'rotate-180 text-brand' : ''}`} />
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
                                        className="overflow-hidden border-t border-line bg-ink/[0.02]"
                                      >
                                        <div className="p-6 space-y-6">
                                          {/* Discrepancy analysis summary inside dropdown */}
                                          {li.approvedTotal && (
                                            <div className="bg-ink/[0.03] rounded-card p-4 border border-line flex flex-col sm:flex-row justify-between gap-3 text-[12.5px]">
                                              <div className="space-y-1">
                                                <p className="text-muted font-light">Calculation Details</p>
                                                <p className="font-semibold text-ink">
                                                  Approved rate: ${Number(li.negotiatedRate).toFixed(2)} / {li.unit} + 13% HST
                                                </p>
                                              </div>
                                              <div className="text-left sm:text-right space-y-0.5 flex-shrink-0">
                                                <div className="flex items-center sm:justify-end gap-2">
                                                  <span className="text-muted">Approved Total:</span>
                                                  <span className="font-bold text-brand">${Number(li.approvedTotal).toFixed(2)}</span>
                                                </div>
                                                <div className="flex items-center sm:justify-end gap-2">
                                                  <span className="text-muted">Discrepancy:</span>
                                                  <span className={`font-bold ${Number(li.lineTotal) - Number(li.approvedTotal) !== 0 ? 'text-clay' : 'text-brand'}`}>
                                                    ${(Number(li.lineTotal) - Number(li.approvedTotal)).toFixed(2)}
                                                  </span>
                                                </div>
                                              </div>
                                            </div>
                                          )}

                                          {/* Ticket and Order Matching Grid */}
                                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            
                                            {/* Ticket / Delivery Evidence */}
                                            <div className="bg-surface rounded-card p-5 border border-line shadow-card flex flex-col">
                                              <div className="flex items-center justify-between mb-4 flex-shrink-0">
                                                <span className="text-[12.5px] font-semibold text-ink flex items-center gap-1.5">
                                                  <Truck className="w-3.5 h-3.5 text-brand" /> Delivery Evidence
                                                </span>
                                                {li.matchedTickets?.length > 0 && <CheckCircle className="w-4 h-4 text-brand" />}
                                              </div>
                                              
                                              <div className="flex-1">
                                                {li.matchedTickets?.length > 0 ? (
                                                  <div className="space-y-2">
                                                    {li.matchedTickets.map(t => (
                                                      <div key={t.id} className="bg-ink/[0.03] p-2.5 rounded-control flex items-center gap-3 border border-line group">
                                                        <div 
                                                          className="w-10 h-10 rounded-control overflow-hidden border border-line cursor-pointer flex-shrink-0 bg-surface" 
                                                          onClick={() => setZoomedImage(getFullUrl(t.imageUrl))}
                                                        >
                                                          <img src={ticketThumbnailSrc(t) || getFullUrl(t.imageUrl)} loading="lazy" decoding="async" className="w-full h-full object-cover" alt="Ticket Scan" />
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                          <div className="flex items-center gap-1.5">
                                                            <p className="text-[12.5px] font-semibold text-ink truncate">T-{t.ticketNumber || t.id.substring(0,6)}</p>
                                                            {t.spruceMatched && (
                                                              <span className="bg-brand/12 text-brand px-1 py-0.5 rounded text-[12.5px] font-bold flex items-center gap-0.5"><CheckCircle className="w-2 h-2"/> MATCHED</span>
                                                            )}
                                                          </div>
                                                          <p className="text-[12.5px] font-bold text-brand mt-0.5">{Number(t.quantity)} {t.unit}</p>
                                                        </div>
                                                        <button 
                                                          onClick={() => handleUnlinkTicket(li.id, t.id)}
                                                          disabled={isProcessing}
                                                          className="opacity-0 group-hover:opacity-100 p-1 hover:bg-clay/10 text-clay rounded-control transition-all flex-shrink-0"
                                                          title="Unlink Ticket"
                                                        >
                                                          <X className="w-3 h-3" />
                                                        </button>
                                                      </div>
                                                    ))}
                                                    <button 
                                                      onClick={() => setLinkingLineItem({ id: li.id, type: 'ticket' })} 
                                                      className="w-full mt-1.5 py-2 text-[12.5px] font-semibold text-muted hover:text-brand transition-colors border border-dashed border-line hover:border-brand/40 rounded-control"
                                                    >
                                                      Add Link +
                                                    </button>
                                                  </div>
                                                ) : (
                                                  <div className="py-6 text-center bg-ink/[0.03] rounded-card border-2 border-dashed border-line">
                                                    <AlertTriangle className="w-6 h-6 text-ochre mx-auto mb-2" />
                                                    <button 
                                                      onClick={() => setLinkingLineItem({ id: li.id, type: 'ticket' })} 
                                                      className="text-[12.5px] font-semibold text-brand hover:underline underline-offset-4"
                                                    >
                                                      Manual Ticket Link
                                                    </button>
                                                  </div>
                                                )}
                                              </div>
                                            </div>

                                            {/* Spruce Order Card */}
                                            <div className="bg-surface rounded-card p-5 border border-line shadow-card flex flex-col">
                                              <div className="flex items-center justify-between mb-4 flex-shrink-0">
                                                <span className="text-[12.5px] font-semibold text-ink flex items-center gap-1.5">
                                                  <ShoppingCart className="w-3.5 h-3.5 text-brand" /> Spruce Order
                                                </span>
                                                {li.matchedOrderId && <CheckCircle className="w-4 h-4 text-brand" />}
                                              </div>

                                              <div className="flex-1">
                                                {li.matchedOrderId ? (
                                                  <div className="space-y-3">
                                                    <div className="bg-brand rounded-control p-4 text-on-brand relative overflow-hidden group shadow-card">
                                                      <div className="relative z-10">
                                                        <p className="text-[12.5px] font-bold text-on-brand mb-0.5">Authorization ID</p>
                                                        <p className="text-sm font-semibold tracking-tight">{li.matchedOrder?.spruceOrderId}</p>
                                                        <div className="flex items-center justify-between mt-3 border-t border-line pt-2 text-[12.5px]">
                                                          <span className="opacity-75">Order Qty</span>
                                                          <span className="font-bold">{Number(li.matchedOrder?.quantity)} {li.matchedOrder?.unit}</span>
                                                        </div>
                                                      </div>
                                                      <button 
                                                        onClick={() => handleUnlinkOrder(li.id)}
                                                        disabled={isProcessing}
                                                        className="absolute top-2.5 right-2.5 opacity-0 group-hover:opacity-100 p-1 bg-surface/10 hover:bg-surface/20 rounded-control transition-all"
                                                        title="Unlink Order"
                                                      >
                                                        <X className="w-3 h-3 text-on-brand" />
                                                      </button>
                                                    </div>
                                                    
                                                    {/* Delivery Driver Sub Details */}
                                                    {li.matchedOrder?.deliveries?.map(del => (
                                                      <div key={del.id} className="bg-ink/[0.03] rounded-control p-3 border border-line space-y-2">
                                                        <div className="flex justify-between items-center">
                                                          <div className="flex items-center gap-1.5">
                                                            <Truck className="w-3.5 h-3.5 text-muted" />
                                                            <span className="text-[12.5px] font-bold text-ink truncate">{del.driver?.name || 'Unassigned'}</span>
                                                          </div>
                                                          <span className={`text-[12.5px] font-bold px-2 py-0.5 rounded-full ${del.status === 'DELIVERED' ? 'bg-brand/12 text-brand' : 'bg-ink/[0.08] text-muted'}`}>
                                                            {del.status.replace('_', ' ')}
                                                          </span>
                                                        </div>
                                                        <div className="grid grid-cols-2 gap-2">
                                                          <div className="border border-line rounded-control overflow-hidden group/img relative bg-surface aspect-video flex flex-col justify-end">
                                                            {del.pickupPhotoUrl ? (
                                                              <img src={getFullUrl(del.pickupPhotoUrl)} className="absolute inset-0 w-full h-full object-cover cursor-pointer hover:opacity-90 transition-opacity" alt="Pickup Photo" onClick={() => setZoomedImage(getFullUrl(del.pickupPhotoUrl))} />
                                                            ) : (
                                                              <span className="text-[12.5px] text-muted absolute inset-0 flex items-center justify-center font-semibold text-center leading-none p-1">No Photo</span>
                                                            )}
                                                            <div className="bg-scrim/40 p-1 relative z-10"><p className="text-[12.5px] text-on-brand font-bold text-center">Pickup</p></div>
                                                          </div>
                                                          <div className="border border-line rounded-control overflow-hidden group/img relative bg-surface aspect-video flex flex-col justify-end">
                                                            {del.deliveryPhotoUrl ? (
                                                              <img src={getFullUrl(del.deliveryPhotoUrl)} className="absolute inset-0 w-full h-full object-cover cursor-pointer hover:opacity-90 transition-opacity" alt="Delivery Photo" onClick={() => setZoomedImage(getFullUrl(del.deliveryPhotoUrl))} />
                                                            ) : (
                                                              <span className="text-[12.5px] text-muted absolute inset-0 flex items-center justify-center font-semibold text-center leading-none p-1">No Photo</span>
                                                            )}
                                                            <div className="bg-scrim/40 p-1 relative z-10"><p className="text-[12.5px] text-on-brand font-bold text-center">Delivery</p></div>
                                                          </div>
                                                        </div>
                                                      </div>
                                                    ))}
                                                  </div>
                                                ) : (
                                                  <div className="py-6 text-center bg-ink/[0.03] rounded-card border-2 border-dashed border-line">
                                                    <Package className="w-6 h-6 text-muted mx-auto mb-2" />
                                                    <button 
                                                      onClick={() => setLinkingLineItem({ id: li.id, type: 'order' })} 
                                                      className="text-[12.5px] font-semibold text-brand hover:underline underline-offset-4"
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

      {filteredInvoices.length > 0 && (
        <div className="mt-6 min-h-12 flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-card border border-line bg-surface px-5 py-3 shadow-card">
          <p className="text-[12.5px] text-muted" aria-live="polite">
            Showing {(page - 1) * INVOICES_PER_PAGE + 1}–{Math.min(page * INVOICES_PER_PAGE, filteredInvoices.length)} of {filteredInvoices.length} invoices
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPage(current => Math.max(1, current - 1))}
              disabled={page <= 1 || loading}
              className="inline-flex items-center gap-1.5 rounded-control border border-line px-3 py-2 text-[12.5px] font-semibold text-ink transition-colors hover:border-brand/40 hover:bg-brand/[0.04] disabled:cursor-not-allowed disabled:opacity-45"
            >
              <ChevronLeft className="h-4 w-4" /> Previous
            </button>
            <span className="min-w-20 text-center text-[12.5px] font-medium text-muted">
              {loading ? 'Loading…' : `${page} / ${totalPages}`}
            </span>
            <button
              type="button"
              onClick={() => setPage(current => Math.min(totalPages, current + 1))}
              disabled={page >= totalPages || loading}
              className="inline-flex items-center gap-1.5 rounded-control border border-line px-3 py-2 text-[12.5px] font-semibold text-ink transition-colors hover:border-brand/40 hover:bg-brand/[0.04] disabled:cursor-not-allowed disabled:opacity-45"
            >
              Next <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* 3. Manual Link Search Overlay Modal */}
      {linkingLineItem && (
        <div className="fixed inset-0 bg-scrim/50 z-[100] flex items-center justify-center p-6 backdrop-blur-sm">
          <div className="bg-surface w-full max-w-xl rounded-card overflow-hidden shadow-overlay animate-in zoom-in-95 duration-200">
            <div className="p-8 border-b border-line flex items-center justify-between bg-ink/[0.03]">
              <div>
                <h2 className="text-2xl font-light text-ink tracking-tight">Manual Association</h2>
                <p className="text-[12.5px] font-semibold text-brand mt-1.5">Lookup {linkingLineItem.type} in central database</p>
              </div>
              <button onClick={() => setLinkingLineItem(null)} className="p-3 hover:bg-ink/[0.06] rounded-card transition-all">
                <X className="w-6 h-6 text-ink" />
              </button>
            </div>
            
            <div className="p-8 space-y-6">
              <div className="relative">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted" />
                <input 
                  type="text" 
                  placeholder={`Search ${linkingLineItem.type}s by code, PO, or material...`}
                  className="w-full pl-12 pr-4 py-4 bg-ink/[0.03] border border-line rounded-card text-base font-light focus:ring-4 focus:ring-brand/20 outline-none transition-all placeholder:text-muted"
                  onChange={e => searchManualLinks(e.target.value)}
                  autoFocus
                />
              </div>

              <div className="max-h-80 overflow-y-auto space-y-2 pr-2 custom-scrollbar">
                {searching ? (
                  <Loader message="Searching records..." />
                ) : searchResults.length === 0 ? (
                  <div className="py-12 text-center text-muted">
                    <Search className="w-12 h-12 mx-auto mb-4 opacity-20" />
                    <p className="font-light text-sm">Type to begin searching</p>
                  </div>
                ) : (
                  searchResults.map(res => (
                    <button 
                      key={res.id} 
                      onClick={() => linkingLineItem.type === 'order' ? handleLinkOrder(res.id) : handleLinkTickets(res.id)}
                      className="w-full flex items-center justify-between p-5 hover:bg-brand/[0.04] rounded-card border border-transparent hover:border-brand/30 transition-all text-left"
                    >
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 bg-surface rounded-control shadow-card border border-line flex items-center justify-center">
                          {linkingLineItem.type === 'order' ? <ShoppingCart className="w-5 h-5 text-brand" /> : <Truck className="w-5 h-5 text-brand" />}
                        </div>
                        <div>
                          <p className="text-base font-semibold text-ink leading-none">{res.spruceOrderId || res.ticketNumber || res.id.substring(0,8)}</p>
                          <p className="text-[12.5px] font-bold text-muted mt-1.5">{res.product || res.material || 'General Material'}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold text-ink">{res.quantity} {res.unit}</p>
                        <div className="flex items-center gap-1 text-[12.5px] font-bold text-brand mt-1">
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
        <div className="fixed inset-0 bg-scrim/95 z-[200] flex flex-col pt-12 pb-6 px-4 sm:px-12 animate-in fade-in duration-300" onClick={() => setZoomedImage(null)}>
          <button className="absolute top-4 right-4 sm:top-8 sm:right-8 z-10 p-3 sm:p-4 bg-surface/10 hover:bg-surface/20 rounded-full text-on-brand transition-all backdrop-blur-md">
            <X className="w-6 h-6 sm:w-8 sm:h-8" />
          </button>
          <div className="flex-1 overflow-y-auto overflow-x-hidden flex justify-center custom-scrollbar rounded-control">
            <img 
              src={zoomedImage} 
              className="w-full max-w-5xl h-auto shadow-overlay rounded-control animate-in zoom-in-95 duration-500 my-auto" 
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
              className="flex items-center gap-2 text-on-brand/60 hover:text-on-brand font-medium text-[12.5px] transition-colors bg-surface/5 hover:bg-surface/10 px-4 py-2 rounded-control"
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
    <div className="flex flex-col h-full bg-canvas -m-8 p-8 overflow-y-auto">
      {/* Skeleton Header Toolbar */}
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 mb-8 bg-surface p-6 rounded-card border border-line shadow-card animate-pulse">
        <PageHeader
          title="Verification desk"
          subtitle="Open an invoice, check the tickets and orders against it, then verify or dispute."
        />
        <div className="flex items-center gap-3">
          <Skeleton variant="rectangle" width="240px" height="42px" className="rounded-control" />
          <Skeleton variant="rectangle" width="300px" height="42px" className="rounded-control" />
        </div>
      </div>

      {/* Skeleton List of Invoice Accordions */}
      <div className="space-y-4 animate-pulse">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="bg-surface rounded-card border border-line p-6 md:p-8 shadow-card flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div className="flex items-center gap-4 flex-1">
              <Skeleton variant="rectangle" width="48px" height="48px" className="rounded-card" />
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
