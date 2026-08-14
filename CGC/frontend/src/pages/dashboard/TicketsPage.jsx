import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSelector } from 'react-redux';
import { useSearchParams } from 'react-router-dom';
import api from '../../api/axios';
import { 
  Search, 
  Eye, 
  AlertCircle, 
  CheckCircle, 
  Filter, 
  Calendar, 
  FileText, 
  Link as LinkIcon,
  Smartphone,
  Mail,
  Upload,
  X,
  ChevronRight,
  ChevronLeft,
  RotateCcw,
  Download
} from 'lucide-react';
import toast from 'react-hot-toast';
import { Skeleton } from '../../components/Skeleton';
import Loader from '../../components/Loader';
import { useIntervalRefresh } from '../../hooks/useIntervalRefresh';
import { ticketThumbnailSrc } from '../../utils/ticketImage';
import { EmptyState, PageHeader, StatusBadge } from '../../components/ui';
import { formatDate } from '../../lib/date';
import {
  getCachedSupplierOptions,
  getCachedTicketPage,
  getCachedTicketStats,
  loadSupplierOptions,
  loadTicketPage,
  loadTicketStats,
} from '../../data/routeData';

// Each row renders a full-resolution ticket photo. Halving the page halves the
// number of images requested and the rows the list query projects. This is an
// interim measure until real thumbnails exist.
const PAGE_SIZE = 25;

// Bounded per request rather than on the shared Axios instance, which is also
// used for uploads and OCR triggers that legitimately take longer.
export default function TicketsPage() {
  const userId = useSelector((state) => state.auth.user?.id);
  const cachedFirstPage = getCachedTicketPage(userId, { page: 1, limit: PAGE_SIZE });
  const cachedStats = getCachedTicketStats(userId);
  const cachedSuppliers = getCachedSupplierOptions(userId);
  const [searchParams, setSearchParams] = useSearchParams();
  const ticketIdParam = searchParams.get('ticketId');
  const [tickets, setTickets] = useState(() => cachedFirstPage?.data || []);
  const [stats, setStats] = useState(() => cachedStats || { unlinkedCount: 0 });
  const [loading, setLoading] = useState(() => !cachedFirstPage);
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [activeTab, setActiveTab] = useState('ALL'); // ALL, UNLINKED, LINKED
  
  // Filters
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const imageInputRef = useRef(null);
  const pdfInputRef = useRef(null);
  // The id prevents a slow response for an earlier filter from replacing a
  // newer result. The data layer deduplicates identical in-flight reads.
  const latestRequestIdRef = useRef(0);
  const [supplierId, setSupplierId] = useState('');
  const [source, setSource] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [suppliers, setSuppliers] = useState(() => cachedSuppliers || []);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Pagination
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(
    () => cachedFirstPage?.pagination?.totalPages || 1,
  );

  const renderPageNumbers = () => {
    const pages = [];
    const maxVisible = 5;
    
    let startPage = Math.max(1, page - 2);
    let endPage = Math.min(totalPages, startPage + maxVisible - 1);
    
    if (endPage - startPage < maxVisible - 1) {
      startPage = Math.max(1, endPage - maxVisible + 1);
    }
    
    // Add dots at the start if needed
    if (startPage > 1) {
      pages.push(
        <button
          key={1}
          onClick={() => setPage(1)}
          className={`relative inline-flex items-center px-4 py-2 border text-sm font-medium transition-all ${
            page === 1
              ? 'z-10 bg-brand/10 border-brand text-brand font-semibold'
              : 'bg-surface border-line text-muted hover:bg-ink/[0.03]'
          }`}
        >
          1
        </button>
      );
      if (startPage > 2) {
        pages.push(
          <span key="dots-start" className="relative inline-flex items-center px-4 py-2 border border-line bg-surface text-sm font-medium text-muted select-none">
            ...
          </span>
        );
      }
    }
    
    for (let i = startPage; i <= endPage; i++) {
      // Don't duplicate page 1 or page totalPages if already added as boundary
      if (i === 1 && startPage > 1) continue;
      if (i === totalPages && endPage < totalPages) continue;

      pages.push(
        <button
          key={i}
          onClick={() => setPage(i)}
          className={`relative inline-flex items-center px-4 py-2 border text-sm font-medium transition-all ${
            page === i
              ? 'z-10 bg-brand/10 border-brand text-brand font-semibold'
              : 'bg-surface border-line text-muted hover:bg-ink/[0.03]'
          }`}
        >
          {i}
        </button>
      );
    }

    // Add dots at the end if needed
    if (endPage < totalPages) {
      if (endPage < totalPages - 1) {
        pages.push(
          <span key="dots-end" className="relative inline-flex items-center px-4 py-2 border border-line bg-surface text-sm font-medium text-muted select-none">
            ...
          </span>
        );
      }
      pages.push(
        <button
          key={totalPages}
          onClick={() => setPage(totalPages)}
          className={`relative inline-flex items-center px-4 py-2 border text-sm font-medium transition-all ${
            page === totalPages
              ? 'z-10 bg-brand/10 border-brand text-brand font-semibold'
              : 'bg-surface border-line text-muted hover:bg-ink/[0.03]'
          }`}
        >
          {totalPages}
        </button>
      );
    }
    
    return pages;
  };


  // Linking
  const [orderSearch, setOrderSearch] = useState('');
  const [orderResults, setOrderResults] = useState([]);
  const [searchingOrders, setSearchingOrders] = useState(false);

  const fetchSuppliers = useCallback(async () => {
    try {
      const data = await loadSupplierOptions(userId, { force: true });
      setSuppliers(data);
    } catch (err) {
      console.error('Error fetching suppliers:', err);
    }
  }, [userId]);

  const fetchStats = useCallback(async () => {
    try {
      const data = await loadTicketStats(userId, { force: true });
      setStats(data);
    } catch (err) {
      console.error('Error fetching ticket stats:', err);
    }
  }, [userId]);

  const fetchTickets = useCallback(async (silent = false) => {
    const requestId = ++latestRequestIdRef.current;
    const isCurrent = () => requestId === latestRequestIdRef.current;
    const queryParams = { page, limit: PAGE_SIZE };
    if (activeTab !== 'ALL') queryParams.status = activeTab;
    if (debouncedSearch && debouncedSearch.trim()) queryParams.search = debouncedSearch.trim();
    if (supplierId) queryParams.supplierId = supplierId;
    if (source) queryParams.source = source;
    if (startDate) queryParams.startDate = startDate;
    if (endDate) queryParams.endDate = endDate;

    const cached = getCachedTicketPage(userId, queryParams);
    if (!silent && cached) {
      setTickets(cached.data);
      setTotalPages(cached.pagination?.totalPages || 1);
      setLoading(false);
    } else if (!silent) {
      setLoading(true);
    }

    try {
      // Railway and the Edge function deploy independently. Race their
      // read-only paginated endpoints so either healthy source can render the
      // table, while the session cache removes repeat-route waits.
      const resultData = await loadTicketPage(userId, queryParams, { force: true });
      if (!isCurrent()) return;
      setTickets(resultData.data);
      setTotalPages(resultData.pagination?.totalPages || 1);
    } catch (err) {
      if (!isCurrent()) return;
      console.error('Error fetching tickets:', err);
      if (!silent && !cached) toast.error('Failed to load tickets');
    } finally {
      if (!silent && isCurrent()) setLoading(false);
    }
  }, [activeTab, debouncedSearch, supplierId, source, startDate, endDate, page, userId]);

  // Reset to page 1 on filter changes
  useEffect(() => {
    setPage(1);
  }, [activeTab, debouncedSearch, supplierId, source, startDate, endDate]);

  useEffect(() => {
    fetchTickets();
  }, [fetchTickets]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  useEffect(() => {
    fetchSuppliers();
  }, [fetchSuppliers]);

  const fetchTicketsRef = useRef(fetchTickets);
  const fetchStatsRef = useRef(fetchStats);

  useEffect(() => {
    fetchTicketsRef.current = fetchTickets;
  }, [fetchTickets]);

  useEffect(() => {
    fetchStatsRef.current = fetchStats;
  }, [fetchStats]);

  useIntervalRefresh(
    () => {
      fetchTicketsRef.current(true);
      fetchStatsRef.current();
    },
    // The list endpoint and the count are the two most expensive calls on this
    // screen. Polling them every 20s put them under constant load for every
    // open dashboard; the hook additionally skips ticks while the tab is hidden.
    60_000
  );

  const handleUpdateTicket = async (id, data) => {
    try {
      await api.put(`/api/tickets/${id}`, data);
      toast.success('Ticket updated');
      fetchTickets();
      fetchStats();
      if (selectedTicket?.id === id) {
        // Refresh details
        const res = await api.get(`/api/tickets/${id}`);
        setSelectedTicket(res.data);
      }
    } catch {
      toast.error('Failed to update ticket');
    }
  };

  const handleFileUpload = async (event, uploadType) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const isImage = uploadType === 'IMAGE';
    const allowedRegex = isImage ? /\.(jpg|jpeg|png)$/i : /\.pdf$/i;
    const allowedMsg = isImage ? 'Please upload a valid JPG or PNG image' : 'Please upload a valid PDF file';

    if (!file.name.match(allowedRegex)) {
      toast.error(allowedMsg);
      return;
    }

    const formData = new FormData();
    formData.append('file', file);

    setIsUploading(true);
    try {
      const endpoint = isImage ? '/api/tickets/upload' : '/api/tickets/upload-pdf';
      await api.post(endpoint, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success(isImage ? 'Ticket uploaded and processing!' : 'PDF split and tickets queued for OCR!');
      fetchTickets();
      fetchStats();
    } catch {
      toast.error('Upload failed');
    } finally {
      setIsUploading(false);
      if (imageInputRef.current) imageInputRef.current.value = '';
      if (pdfInputRef.current) pdfInputRef.current.value = '';
    }
  };

  const handleDownloadTicketImage = async (ticketUrl, ticketNumber) => {
    if (!ticketUrl) {
      toast.error('No image available to download');
      return;
    }

    const toastId = toast.loading('Downloading ticket file...');
    try {
      const baseUrl = import.meta.env.VITE_API_URL || 'https://cambridge-garden-centre-1.onrender.com';
      const fullUrl = ticketUrl.startsWith('http') 
        ? ticketUrl 
        : `${baseUrl}${ticketUrl}`;

      const response = await fetch(fullUrl);
      if (!response.ok) throw new Error('Network response was not ok');

      const blob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;

      let ext = 'jpg';
      const lowerUrl = ticketUrl.toLowerCase();
      if (lowerUrl.endsWith('.pdf') || blob.type === 'application/pdf') {
        ext = 'pdf';
      } else if (lowerUrl.endsWith('.png') || blob.type === 'image/png') {
        ext = 'png';
      } else if (lowerUrl.endsWith('.jpeg')) {
        ext = 'jpeg';
      }

      a.download = `Ticket_${ticketNumber || 'image'}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(downloadUrl);

      toast.success('Ticket downloaded successfully', { id: toastId });
    } catch (err) {
      console.error('Failed to download ticket image:', err);
      const baseUrl = import.meta.env.VITE_API_URL || 'https://cambridge-garden-centre-1.onrender.com';
      const fallbackUrl = ticketUrl.startsWith('http') 
        ? ticketUrl 
        : `${baseUrl}${ticketUrl}`;
      window.open(fallbackUrl, '_blank');
      toast.success('Opening file in new tab', { id: toastId });
    }
  };

  const activeTicketIdRef = useRef(null);

  const handleCloseReviewModal = useCallback(() => {
    activeTicketIdRef.current = null;
    setSelectedTicket(null);
    if (searchParams.has('ticketId')) {
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('ticketId');
      setSearchParams(newParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const handleOpenReviewModal = useCallback(async (ticket) => {
    activeTicketIdRef.current = ticket.id;
    setSelectedTicket(ticket);
    const newParams = new URLSearchParams(searchParams);
    newParams.set('ticketId', ticket.id);
    setSearchParams(newParams, { replace: true });
    try {
      const res = await api.get(`/api/tickets/${ticket.id}`);
      if (activeTicketIdRef.current === ticket.id) {
        setSelectedTicket(res.data);
      }
    } catch (err) {
      console.error('Failed to load full ticket details:', err);
    }
  }, [searchParams, setSearchParams]);

  // Sync ticket review modal with URL query parameter
  useEffect(() => {
    if (ticketIdParam) {
      activeTicketIdRef.current = ticketIdParam;
      let isSubscribed = true;
      api.get(`/api/tickets/${ticketIdParam}`)
        .then(res => {
          if (isSubscribed && activeTicketIdRef.current === ticketIdParam && res.data) {
            setSelectedTicket(res.data);
          }
        })
        .catch(err => {
          console.error('Failed to load ticket for review from URL:', err);
        });
      return () => {
        isSubscribed = false;
      };
    } else {
      activeTicketIdRef.current = null;
      setSelectedTicket(null);
    }
  }, [ticketIdParam]);

  const handleLinkToOrder = async (ticketId, orderId) => {
    try {
      await api.post(`/api/tickets/${ticketId}/link`, { orderId });
      toast.success('Ticket linked to order');
      // Refresh ticket details
      if (activeTicketIdRef.current === ticketId) {
        const res = await api.get(`/api/tickets/${ticketId}`);
        if (activeTicketIdRef.current === ticketId) {
          setSelectedTicket(res.data);
        }
      }
      fetchTickets();
      fetchStats();
    } catch {
      toast.error('Failed to link ticket');
    }
  };

  const handleUnlinkOrder = async (ticketId, orderId) => {
    try {
      await api.post(`/api/tickets/${ticketId}/unlink`, { orderId });
      toast.success('Ticket unlinked from order');
      // Refresh ticket details if modal is open
      if (activeTicketIdRef.current === ticketId) {
        const res = await api.get(`/api/tickets/${ticketId}`);
        if (activeTicketIdRef.current === ticketId) {
          setSelectedTicket(res.data);
        }
      }
      fetchTickets();
      fetchStats();
    } catch {
      toast.error('Failed to unlink ticket');
    }
  };

  const orderSearchTimeoutRef = useRef(null);

  const searchOrders = async (query) => {
    if (orderSearchTimeoutRef.current) {
      clearTimeout(orderSearchTimeoutRef.current);
    }

    if (!query) {
      setOrderResults([]);
      setSearchingOrders(false);
      return;
    }

    setSearchingOrders(true);
    orderSearchTimeoutRef.current = setTimeout(async () => {
      try {
        const res = await api.get('/api/orders', { params: { search: query } });
        setOrderResults(res.data?.data || res.data || []);
      } catch (err) {
        console.error('Order search error:', err);
      } finally {
        setSearchingOrders(false);
      }
    }, 300);
  };

  return (
    <div className="flex flex-col h-full space-y-4 relative">
      {/* Header & Stats */}
      <PageHeader
        title="Tickets"
        subtitle="Photos of what arrived. Link each one to a Spruce order so invoices can be checked."
        actions={
        <div className="flex gap-3 items-center">
          <input 
            type="file" 
            accept=".jpg,.jpeg,.png" 
            ref={imageInputRef} 
            onChange={(e) => handleFileUpload(e, 'IMAGE')} 
            className="hidden" 
          />
          <input 
            type="file" 
            accept=".pdf" 
            ref={pdfInputRef} 
            onChange={(e) => handleFileUpload(e, 'PDF')} 
            className="hidden" 
          />
          <button
            onClick={() => imageInputRef.current?.click()}
            disabled={isUploading}
            className="flex items-center gap-2 bg-brand hover:brightness-110 text-on-brand px-4 py-2 rounded-pill font-medium text-[13px] transition-all shadow-card disabled:opacity-50"
          >
            {isUploading ? <Loader size="inline" /> : <Upload className="w-4 h-4" />}
            {isUploading ? 'Processing...' : 'Upload Ticket Image'}
          </button>
          <button
            onClick={() => pdfInputRef.current?.click()}
            disabled={isUploading}
            className="flex items-center gap-2 bg-brand hover:brightness-110 text-on-brand px-4 py-2 rounded-control font-medium text-[12.5px] transition-all shadow-card disabled:opacity-50"
          >
            {isUploading ? <Loader size="inline" /> : <Upload className="w-4 h-4" />}
            {isUploading ? 'Processing...' : 'Upload ticket PDF'}
          </button>

          <div className="bg-ochre/15 border border-ochre/30 rounded-control p-3 flex items-center gap-3">
             <div className="bg-ochre/20 p-2 rounded-full">
                <AlertCircle className="w-5 h-5 text-ochre" />
             </div>
             <div>
                <p className="text-[12.5px] text-ink font-medium">Needs attention</p>
                <p className="tabular text-xl font-bold text-ink">{stats.unlinkedCount} unlinked</p>
             </div>
          </div>
        </div>
        }
      />

      {/* Tabs & Filters */}
      <div className="bg-surface rounded-card border border-line shadow-card overflow-hidden">
        <div className="border-b border-line">
          <nav className="flex -mb-px" aria-label="Tabs">
            {[
              { id: 'ALL', name: 'All Tickets' },
              { id: 'UNLINKED', name: 'Unlinked', count: stats.unlinkedCount },
              { id: 'LINKED', name: 'Linked' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`
                  relative min-w-0 flex-1 overflow-hidden py-4 px-4 text-sm font-medium text-center hover:bg-ink/[0.03] focus:z-10 transition-colors
                  ${activeTab === tab.id 
                    ? 'text-brand border-b-2 border-brand bg-brand/[0.06]' 
                    : 'text-muted border-b-2 border-transparent hover:text-ink'}
                `}
              >
                <span className="flex items-center justify-center gap-2">
                  {tab.name}
                  {tab.count !== undefined && (
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[12.5px] font-medium ${activeTab === tab.id ? 'bg-brand/12 text-brand' : 'bg-ink/[0.06] text-ink'}`}>
                      {tab.count}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </nav>
        </div>

        <div className="p-4 flex flex-wrap gap-4 items-end">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-[12.5px] font-medium text-ink mb-1">Search</label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
              <input 
                type="text" 
                placeholder="Ticket #, PO, Material..."
                className="w-full pl-10 pr-4 py-2 border rounded-control text-sm focus:ring-2 focus:ring-brand focus:border-brand"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>

          <div className="w-48">
            <label className="block text-[12.5px] font-medium text-ink mb-1">Supplier</label>
            <select 
              className="w-full p-2 border rounded-control text-sm bg-surface"
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
            >
              <option value="">All Suppliers</option>
              {suppliers.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>

          <div className="w-40">
            <label className="block text-[12.5px] font-medium text-ink mb-1">Source</label>
            <select 
              className="w-full p-2 border rounded-control text-sm"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            >
              <option value="">All Sources</option>
              <option value="WHATSAPP">WhatsApp</option>
              <option value="EMAIL">Email</option>
              <option value="MANUAL">Manual Upload</option>
            </select>
          </div>

          <div className="w-72 md:w-80">
             <label className="block text-[12.5px] font-medium text-ink mb-1">Date Range</label>
             <div className="flex items-center gap-1.5">
                <input 
                  type="date" 
                  className="w-full min-w-0 p-2 border rounded-control text-[12.5px] focus:ring-2 focus:ring-brand focus:border-brand bg-surface" 
                  value={startDate} 
                  onChange={e => setStartDate(e.target.value)} 
                />
                <span className="text-muted font-medium">-</span>
                <input 
                  type="date" 
                  className="w-full min-w-0 p-2 border rounded-control text-[12.5px] focus:ring-2 focus:ring-brand focus:border-brand bg-surface" 
                  value={endDate} 
                  onChange={e => setEndDate(e.target.value)} 
                />
             </div>
          </div>

          <button 
            onClick={() => {
              setSearch('');
              setDebouncedSearch('');
              setSource('');
              setSupplierId('');
              setStartDate('');
              setEndDate('');
            }}
            className="p-2 text-muted hover:text-ink transition-colors"
            title="Clear Filters"
          >
            <RotateCcw className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Tickets Table */}
      <div className="flex-1 bg-surface rounded-card border border-line shadow-card overflow-hidden flex flex-col">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-line">
            <thead className="bg-ink/[0.03] whitespace-nowrap">
              <tr>
                <th colSpan="2" className="px-6 py-3 text-left text-[12.5px] font-medium text-muted">Ticket / Image</th>
                <th className="px-6 py-3 text-left text-[12.5px] font-medium text-muted">Supplier</th>
                <th className="px-6 py-3 text-left text-[12.5px] font-medium text-muted">Material</th>
                <th className="px-6 py-3 text-left text-[12.5px] font-medium text-muted">Quantity</th>
                <th className="px-6 py-3 text-left text-[12.5px] font-medium text-muted">PO #</th>
                <th className="px-6 py-3 text-left text-[12.5px] font-medium text-muted">Status</th>
                <th className="px-6 py-3 text-right text-[12.5px] font-medium text-muted">Action</th>
              </tr>
            </thead>
            <tbody className="bg-surface divide-y divide-line">
              {loading ? (
                <TicketsTableSkeleton />
              ) : tickets.length === 0 ? (
                <tr><td colSpan="8"><EmptyState title="No tickets match" message="Try another tab, search, or date range — or upload a ticket photo." /></td></tr>
              ) : (
                tickets.map((ticket) => (
                  <tr key={ticket.id} className="hover:bg-ink/[0.03] transition-colors group">
                    <td className="px-6 py-4 whitespace-nowrap w-20">
                      <div className="w-12 h-12 bg-ink/[0.06] rounded-control overflow-hidden border border-line cursor-zoom-in" onClick={() => handleOpenReviewModal(ticket)}>
                        {ticket.imageUrl ? (
                          <img
                            src={ticketThumbnailSrc(ticket)}
                            alt="Ticket thumb"
                            className="w-full h-full object-cover"
                            // These are full-resolution phone photos (~615 KB,
                            // 1800x2391) rendered into 48 CSS px. Until real
                            // thumbnails exist, native lazy loading at least
                            // defers offscreen rows. Browsers choose their own
                            // preload distance, so this reduces the initial
                            // burst rather than guaranteeing only visible rows
                            // are fetched.
                            loading="lazy"
                            decoding="async"
                            width={48}
                            height={48}
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-muted">
                             <FileText className="w-5 h-5" />
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-0 py-4 whitespace-nowrap">
                      <div className="text-sm font-medium text-ink flex items-center gap-2">
                        {ticket.ticketNumber || 'No Ticket #'}
                        {ticket.source === 'WHATSAPP' ? (
                          <Smartphone className="w-3 h-3 text-brand" title="WhatsApp" />
                        ) : ticket.source === 'EMAIL' ? (
                          <Mail className="w-3 h-3 text-brand" title="Email" />
                        ) : (
                        <></>
                       )}
                        {ticket.imageUrl && (
                           <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDownloadTicketImage(ticket.imageUrl, ticket.ticketNumber);
                            }}
                            className="p-1 text-muted hover:text-brand hover:bg-brand/10 rounded transition-colors"
                            title="Download Ticket Image"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                      <div className="text-[12.5px] text-muted">{formatDate(ticket.receivedAt)}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-ink">
                      {ticket.supplier?.name || ticket.supplierName || '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-muted">
                      {ticket.material || '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-ink font-medium">
                      {ticket.quantity ? `${ticket.quantity} ${ticket.unit || 'ton'}` : '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-muted">
                      {ticket.poNumber || '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <StatusBadge status={ticket.status} />
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <button 
                        onClick={() => handleOpenReviewModal(ticket)}
                        className="text-brand hover:text-brand bg-brand/10 hover:bg-brand/10 px-3 py-1.5 rounded-control transition-colors inline-flex items-center gap-2"
                      >
                        <Eye className="w-4 h-4" /> Review
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Controls */}
        <div className="bg-surface px-4 py-3 flex items-center justify-between border-t border-line sm:px-6">
          <div className="flex-1 flex justify-between sm:hidden">
            <button
              onClick={() => setPage(p => Math.max(p - 1, 1))}
              disabled={page === 1}
              className="relative inline-flex items-center px-4 py-2 border border-line text-sm font-medium rounded-control text-ink bg-surface hover:bg-ink/[0.03] disabled:opacity-50 transition-all"
            >
              Previous
            </button>
            <button
              onClick={() => setPage(p => Math.min(p + 1, totalPages))}
              disabled={page === totalPages}
              className="ml-3 relative inline-flex items-center px-4 py-2 border border-line text-sm font-medium rounded-control text-ink bg-surface hover:bg-ink/[0.03] disabled:opacity-50 transition-all"
            >
              Next
            </button>
          </div>
          <div className="hidden sm:flex-1 sm:flex sm:items-center sm:justify-between">
            <div>
              <p className="text-sm text-ink">
                Showing page <span className="font-medium">{page}</span> of{' '}
                <span className="font-medium">{totalPages}</span>
              </p>
            </div>
            <div>
              <nav className="relative z-0 inline-flex rounded-control shadow-card -space-x-px" aria-label="Pagination">
                <button
                  onClick={() => setPage(p => Math.max(p - 1, 1))}
                  disabled={page === 1}
                  className="relative inline-flex items-center px-2 py-2 rounded-l-md border border-line bg-surface text-sm font-medium text-muted hover:bg-ink/[0.03] disabled:opacity-50 transition-all"
                >
                  <span className="sr-only">Previous</span>
                  <ChevronLeft className="h-5 w-5" aria-hidden="true" />
                </button>
                {renderPageNumbers()}
                <button
                  onClick={() => setPage(p => Math.min(p + 1, totalPages))}
                  disabled={page === totalPages}
                  className="relative inline-flex items-center px-2 py-2 rounded-r-md border border-line bg-surface text-sm font-medium text-muted hover:bg-ink/[0.03] disabled:opacity-50 transition-all"
                >
                  <span className="sr-only">Next</span>
                  <ChevronRight className="h-5 w-5" aria-hidden="true" />
                </button>
              </nav>
            </div>
          </div>
        </div>
      </div>

      {/* Detail Modal */}
      {selectedTicket && (
        <div className="fixed inset-0 z-50 overflow-hidden flex items-center justify-center" aria-labelledby="modal-title" role="dialog" aria-modal="true">
          <div className="flex items-center justify-center min-h-screen w-full p-4 text-center">
            <div className="fixed inset-0 bg-ink/60 bg-opacity-75 transition-opacity backdrop-blur-sm"></div>

            <div 
              className="inline-block align-middle bg-surface rounded-card text-left overflow-hidden shadow-overlay transform transition-all sm:max-w-6xl sm:w-full h-[90vh] flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              
              <div className="flex justify-between items-center px-6 py-4 border-b bg-ink/[0.03]">
                <div className="flex items-center gap-3">
                  <h3 className="text-lg font-bold text-ink">
                    Ticket Review: {selectedTicket.ticketNumber || 'Unknown'}
                  </h3>
                  <StatusBadge status={selectedTicket.status} />
                  {selectedTicket.driver?.name && (
                    <span className="bg-ink/[0.05] border border-line text-brand px-2.5 py-0.5 rounded-full text-[12.5px] font-semibold" title="Uploaded by Driver">
                      Driver: {selectedTicket.driver.name}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {selectedTicket.imageUrl && (
                    <button
                      type="button"
                      onClick={() => handleDownloadTicketImage(selectedTicket.imageUrl, selectedTicket.ticketNumber)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-surface border border-line hover:border-brand/40 text-ink hover:text-brand rounded-control text-[12.5px] font-semibold shadow-card transition-all"
                      title="Download Ticket File"
                    >
                      <Download className="w-3.5 h-3.5 text-brand" />
                      Download
                    </button>
                  )}
                  <button onClick={handleCloseReviewModal} className="text-muted hover:text-ink transition-colors p-1 rounded-full hover:bg-ink/[0.06]">
                    <X className="w-6 h-6" />
                  </button>
                </div>
              </div>

              <div className="flex flex-1 overflow-hidden">
                {/* Image Side */}
                <div className="flex-[1.2] bg-ink p-4 flex items-center justify-center overflow-hidden border-r relative group">
                  {selectedTicket.imageUrl ? (
                    selectedTicket.imageUrl.toLowerCase().endsWith('.pdf') ? (
                      <iframe
                        src={selectedTicket.imageUrl.startsWith('http') ? selectedTicket.imageUrl : `${import.meta.env.VITE_API_URL || 'http://localhost:4000'}${selectedTicket.imageUrl}`}
                        className="w-full h-full border-0 bg-surface"
                        title="PDF Ticket"
                      />
                    ) : (
                      <img 
                        src={selectedTicket.imageUrl.startsWith('http') ? selectedTicket.imageUrl : `${import.meta.env.VITE_API_URL || 'http://localhost:4000'}${selectedTicket.imageUrl}`} 
                        className="max-w-full max-h-full object-contain shadow-overlay transition-transform duration-300 group-hover:scale-[1.02]"
                        alt="Full ticket"
                      />
                    )
                  ) : (
                    <div className="text-muted flex flex-col items-center">
                       <FileText className="w-16 h-16 mb-2 opacity-20" />
                       No image available
                    </div>
                  )}
                </div>

                {/* Data & Linking Side */}
                <div className="flex-1 overflow-y-auto p-6 bg-surface space-y-8">
                  
                  {/* OCR Data Section */}
                  <section>
                    <div className="flex items-center justify-between mb-4">
                      <h4 className="text-sm font-bold text-ink flex items-center gap-2">
                        <FileText className="w-4 h-4 text-brand" /> Extracted Information
                      </h4>
                      <p className="text-[12.5px] text-muted font-medium">Values can be manually overridden</p>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <label className="text-[12.5px] font-bold text-muted px-1">Supplier</label>
                        <input 
                          type="text" 
                          className="w-full p-2.5 bg-ink/[0.03] border border-line rounded-control text-sm focus:ring-2 focus:ring-brand outline-none transition-all"
                          defaultValue={selectedTicket.supplier?.name || selectedTicket.supplierName}
                          onBlur={(e) => handleUpdateTicket(selectedTicket.id, { supplierName: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[12.5px] font-bold text-muted px-1">Ticket Date</label>
                        <input 
                          type="date" 
                          className="w-full p-2.5 bg-ink/[0.03] border border-line rounded-control text-sm focus:ring-2 focus:ring-brand outline-none"
                          defaultValue={selectedTicket.ticketDate ? new Date(selectedTicket.ticketDate).toISOString().split('T')[0] : ''}
                          onBlur={(e) => handleUpdateTicket(selectedTicket.id, { ticketDate: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[12.5px] font-bold text-muted px-1">Ticket Number</label>
                        <input 
                          type="text" 
                          className="w-full p-2.5 bg-ink/[0.03] border border-line rounded-control text-sm focus:ring-2 focus:ring-brand outline-none"
                          defaultValue={selectedTicket.ticketNumber}
                          onBlur={(e) => handleUpdateTicket(selectedTicket.id, { ticketNumber: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[12.5px] font-bold text-muted px-1">PO Number</label>
                        <input 
                          type="text" 
                          className="w-full p-2.5 bg-ink/[0.03] border border-line rounded-control text-sm focus:ring-2 focus:ring-brand outline-none"
                          defaultValue={selectedTicket.poNumber}
                          onBlur={(e) => handleUpdateTicket(selectedTicket.id, { poNumber: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[12.5px] font-bold text-muted px-1">Material</label>
                        <input 
                          type="text" 
                          className="w-full p-2.5 bg-ink/[0.03] border border-line rounded-control text-sm focus:ring-2 focus:ring-brand outline-none"
                          defaultValue={selectedTicket.material}
                          onBlur={(e) => handleUpdateTicket(selectedTicket.id, { material: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[12.5px] font-bold text-muted px-1">Quantity</label>
                        <div className="relative">
                          <input 
                            type="number" 
                            className="w-full p-2.5 bg-ink/[0.03] border border-line rounded-control text-sm focus:ring-2 focus:ring-brand outline-none"
                            defaultValue={selectedTicket.quantity}
                            onBlur={(e) => handleUpdateTicket(selectedTicket.id, { quantity: parseFloat(e.target.value) })}
                          />
                        </div>
                      </div>
                    </div>
                  </section>

                  <hr className="border-line" />

                  {/* Linking Section */}
                  <section className="bg-brand/10 p-6 rounded-card border border-brand/20">
                    <div className="flex items-center justify-between mb-4">
                      <h4 className="text-sm font-bold text-ink flex items-center gap-2">
                        <LinkIcon className="w-4 h-4 text-brand" /> Linked Orders
                      </h4>
                    </div>

                    <div className="space-y-4">
                      {/* List of currently linked orders */}
                      {(selectedTicket.orderMatches?.length > 0 || selectedTicket.linkedOrder) ? (
                        <div className="space-y-2">
                          <p className="text-[12.5px] font-bold text-muted px-1">Linked Records</p>
                          
                          {/* Many-to-many matches */}
                          {selectedTicket.orderMatches?.map(match => (
                            <div key={match.id} className="bg-surface p-3 rounded-control border border-brand/30 flex items-center justify-between shadow-card">
                               <div>
                                  <p className="text-sm font-bold text-ink">Spruce ID: {match.order?.spruceOrderId || 'N/A'}</p>
                                  <p className="text-[12.5px] text-muted">Customer: {match.order?.customerName || 'Unknown'}</p>
                                  <p className="text-[12.5px] text-muted">Method: {match.matchMethod}</p>
                               </div>
                               <button 
                                onClick={() => handleUnlinkOrder(selectedTicket.id, match.orderId)}
                                className="text-[12.5px] text-clay hover:bg-clay/10 p-2 rounded-control font-bold transition-colors"
                                title="Unlink Order"
                               >
                                  <X className="w-4 h-4" />
                               </button>
                            </div>
                          ))}

                          {/* Fallback for legacy single-order link if no matches records exist */}
                          {(!selectedTicket.orderMatches || selectedTicket.orderMatches.length === 0) && selectedTicket.linkedOrder && (
                            <div className="bg-surface p-3 rounded-control border border-ochre/30 flex items-center justify-between shadow-card">
                               <div>
                                  <p className="text-sm font-bold text-ink">Spruce ID: {selectedTicket.linkedOrder.spruceOrderId}</p>
                                  <p className="text-[12.5px] text-muted">Customer: {selectedTicket.linkedOrder.customerName}</p>
                                  <p className="text-[12.5px] text-muted">Method: {selectedTicket.linkMethod} (Legacy)</p>
                               </div>
                               <button 
                                onClick={() => handleUnlinkOrder(selectedTicket.id, selectedTicket.linkedOrderId)}
                                className="text-[12.5px] text-clay hover:bg-clay/10 p-2 rounded-control font-bold transition-colors"
                                title="Unlink Order"
                               >
                                  <X className="w-4 h-4" />
                               </button>
                            </div>
                          )}
                        </div>
                      ) : null}

                      {/* Search for more orders to link */}
                      <div className="space-y-3 pt-4 border-t border-line">
                         <p className="text-[12.5px] font-bold text-muted px-1">Link {selectedTicket.orderMatches?.length > 0 ? 'Another' : 'an'} Order</p>
                         <div className="relative">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
                            <input 
                              type="text" 
                              placeholder="Search Order by PO, Customer, ID..."
                              className="w-full pl-10 pr-4 py-3 bg-surface border border-line rounded-control text-sm focus:ring-2 focus:ring-brand outline-none shadow-card"
                              value={orderSearch}
                              onChange={(e) => {
                                setOrderSearch(e.target.value);
                                searchOrders(e.target.value);
                              }}
                            />
                         </div>

                         <div className="space-y-2 max-h-48 overflow-y-auto pr-2 custom-scrollbar">
                            {searchingOrders ? (
                              <div className="text-center py-4 text-muted text-[12.5px] italic">Searching available orders...</div>
                            ) : orderResults.length > 0 ? (
                               orderResults.map(order => (
                                 <div key={order.id} className="bg-surface p-3 rounded-control border border-line flex items-center justify-between hover:border-brand/40 transition-all shadow-card group">
                                    <div className="flex-1">
                                       <p className="text-sm font-bold text-ink">{order.customerName}</p>
                                       <p className="text-[12.5px] text-muted">ID: {order.spruceOrderId} | PO: {order.poNumber || 'N/A'}</p>
                                    </div>
                                    <div className="flex items-center gap-3">
                                       <span className="text-[12.5px] font-bold text-muted">{order.product}</span>
                                       <button 
                                          onClick={() => handleLinkToOrder(selectedTicket.id, order.id)}
                                          className="bg-brand text-on-brand p-2 rounded-control opacity-0 group-hover:opacity-100 transition-opacity"
                                          disabled={selectedTicket.orderMatches?.some(m => m.orderId === order.id)}
                                       >
                                          {selectedTicket.orderMatches?.some(m => m.orderId === order.id) ? <CheckCircle className="w-4 h-4" /> : <LinkIcon className="w-4 h-4" />}
                                       </button>
                                    </div>
                                 </div>
                               ))
                            ) : orderSearch ? (
                               <div className="text-center py-4 text-muted text-[12.5px] italic">No matching orders found</div>
                            ) : (
                               <div className="text-center py-4 text-muted text-[12.5px] italic">Enter search criteria above</div>
                            )}
                         </div>
                      </div>
                    </div>
                  </section>
                </div>
              </div>

            </div>
          </div>
        </div>
      )}

    </div>
  );
}

function TicketsTableSkeleton() {
  return (
    <>
      {[...Array(8)].map((_, i) => (
        <tr key={i}>
          <td className="px-6 py-4 whitespace-nowrap w-20">
            <Skeleton variant="rectangle" width="48px" height="48px" className="rounded-control" />
          </td>
          <td className="px-0 py-4 whitespace-nowrap space-y-2">
            <Skeleton variant="text" width="100px" height="16px" />
            <Skeleton variant="text" width="80px" height="12px" />
          </td>
          <td className="px-6 py-4 whitespace-nowrap">
            <Skeleton variant="text" width="120px" height="16px" />
          </td>
          <td className="px-6 py-4 whitespace-nowrap">
            <Skeleton variant="text" width="100px" height="16px" />
          </td>
          <td className="px-6 py-4 whitespace-nowrap">
            <Skeleton variant="text" width="80px" height="16px" />
          </td>
          <td className="px-6 py-4 whitespace-nowrap">
            <Skeleton variant="text" width="60px" height="16px" />
          </td>
          <td className="px-6 py-4 whitespace-nowrap">
            <Skeleton variant="rectangle" width="70px" height="20px" className="rounded-full" />
          </td>
          <td className="px-6 py-4 whitespace-nowrap text-right">
            <Skeleton variant="rectangle" width="80px" height="32px" className="rounded-control ml-auto" />
          </td>
        </tr>
      ))}
    </>
  );
}
