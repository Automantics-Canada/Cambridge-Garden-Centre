import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api/axios';
import { supabase } from '../../supabaseClient';
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

// Each row renders a full-resolution ticket photo. Halving the page halves the
// number of images requested and the rows the list query projects. This is an
// interim measure until real thumbnails exist.
const PAGE_SIZE = 25;

// Bounded per request rather than on the shared Axios instance, which is also
// used for uploads and OCR triggers that legitimately take longer.
const TICKETS_REQUEST_TIMEOUT_MS = 15_000;

function isAbortError(error) {
  return (
    error?.code === 'ERR_CANCELED' ||
    error?.name === 'CanceledError' ||
    error?.name === 'AbortError'
  );
}

/**
 * Whether a failed backend call is worth retrying through the Edge function.
 *
 * Only transport-level failures and server faults are. A 4xx is a definitive
 * answer — retrying an auth or validation failure doubles the latency and hides
 * the real cause behind a second, unrelated error.
 */
function shouldFallBackToEdge(error) {
  if (isAbortError(error)) return false;
  if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT') return true;
  const status = error?.response?.status;
  if (status === undefined) return true; // network error, no response received
  return status >= 500;
}

export default function TicketsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const ticketIdParam = searchParams.get('ticketId');
  const [tickets, setTickets] = useState([]);
  const [stats, setStats] = useState({ unlinkedCount: 0 });
  const [loading, setLoading] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [activeTab, setActiveTab] = useState('ALL'); // ALL, UNLINKED, LINKED
  
  // Filters
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const imageInputRef = useRef(null);
  const pdfInputRef = useRef(null);
  // Cancels the in-flight tickets request; the id guards against a superseded
  // response still reaching setState if it resolves before the abort lands.
  const requestAbortRef = useRef(null);
  const latestRequestIdRef = useRef(0);
  const [supplierId, setSupplierId] = useState('');
  const [source, setSource] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [suppliers, setSuppliers] = useState([]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Drop any in-flight tickets request when the page unmounts.
  useEffect(() => () => requestAbortRef.current?.abort(), []);

  // Pagination
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

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
              ? 'z-10 bg-green-50 border-green-500 text-green-600 font-semibold'
              : 'bg-white border-gray-300 text-gray-500 hover:bg-gray-50'
          }`}
        >
          1
        </button>
      );
      if (startPage > 2) {
        pages.push(
          <span key="dots-start" className="relative inline-flex items-center px-4 py-2 border border-gray-300 bg-white text-sm font-medium text-gray-500 select-none">
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
              ? 'z-10 bg-green-50 border-green-500 text-green-600 font-semibold'
              : 'bg-white border-gray-300 text-gray-500 hover:bg-gray-50'
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
          <span key="dots-end" className="relative inline-flex items-center px-4 py-2 border border-gray-300 bg-white text-sm font-medium text-gray-500 select-none">
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
              ? 'z-10 bg-green-50 border-green-500 text-green-600 font-semibold'
              : 'bg-white border-gray-300 text-gray-500 hover:bg-gray-50'
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
      // Only id and name are needed to populate the filter dropdown. Fetching
      // 1000 complete supplier records for this cost ~2.7s in production.
      const res = await api.get('/api/suppliers/options');
      setSuppliers(res.data || []);
    } catch (err) {
      console.error('Error fetching suppliers:', err);
    }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const res = await api.get('/api/tickets/stats');
      setStats({ unlinkedCount: res.data?.unlinkedCount || 0 });
    } catch (err) {
      console.error('Error fetching ticket stats:', err);
    }
  }, []);

  const fetchTickets = useCallback(async (silent = false) => {
    // Supersede any in-flight request. Without this, a slow response for an
    // earlier filter could resolve after a newer one and overwrite the list
    // with stale rows.
    requestAbortRef.current?.abort();
    const controller = new AbortController();
    requestAbortRef.current = controller;

    const requestId = ++latestRequestIdRef.current;
    const isCurrent = () => requestId === latestRequestIdRef.current;

    if (!silent) setLoading(true);
    try {
      const queryParams = {
        page,
        limit: PAGE_SIZE,
      };
      if (activeTab !== 'ALL') queryParams.status = activeTab;
      if (debouncedSearch && debouncedSearch.trim()) queryParams.search = debouncedSearch.trim();
      if (supplierId) queryParams.supplierId = supplierId;
      if (source) queryParams.source = source;
      if (startDate) queryParams.startDate = startDate;
      if (endDate) queryParams.endDate = endDate;

      let resultData = null;
      try {
        const res = await api.get('/api/tickets', {
          params: queryParams,
          signal: controller.signal,
          // Bounded per request rather than globally: the shared Axios instance
          // is used by uploads and OCR triggers that legitimately run longer.
          timeout: TICKETS_REQUEST_TIMEOUT_MS,
        });
        resultData = res.data;
      } catch (backendErr) {
        if (isAbortError(backendErr)) return;
        // Only retry through the Edge function when the backend was unreachable
        // or failed server-side. A 400/401/403 is a definitive answer and
        // retrying it just doubles the latency and hides the real cause.
        if (!shouldFallBackToEdge(backendErr)) throw backendErr;

        console.warn('Backend tickets call failed, falling back to edge function:', backendErr);
        const params = new URLSearchParams({
          resource: 'tickets',
          page: String(page),
          limit: String(PAGE_SIZE)
        });
        if (activeTab !== 'ALL') params.append('status', activeTab);
        if (debouncedSearch && debouncedSearch.trim()) params.append('search', debouncedSearch.trim());
        if (supplierId) params.append('supplierId', supplierId);
        if (source) params.append('source', source);
        if (startDate) params.append('startDate', startDate);
        if (endDate) params.append('endDate', endDate);

        const token = localStorage.getItem('token');
        const headers = token ? { Authorization: `Bearer ${token}` } : {};

        const { data, error } = await supabase.functions.invoke(`fetch-cgc-data?${params.toString()}`, {
          method: 'GET',
          headers
        });
        if (error) throw error;
        resultData = data;
      }

      if (!isCurrent()) return;

      if (resultData && resultData.data) {
        setTickets(resultData.data);
        setTotalPages(resultData.pagination?.totalPages || 1);
      } else if (Array.isArray(resultData)) {
        setTickets(resultData);
        setTotalPages(1);
      } else {
        setTickets([]);
        setTotalPages(1);
      }
    } catch (err) {
      if (isAbortError(err) || !isCurrent()) return;
      console.error('Error fetching tickets:', err);
      if (!silent) toast.error('Failed to load tickets');
    } finally {
      if (!silent && isCurrent()) setLoading(false);
    }
  }, [activeTab, debouncedSearch, supplierId, source, startDate, endDate, page]);

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
    } catch (err) {
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
    } catch (err) {
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
    } catch (err) {
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
    } catch (err) {
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
      <div className="sm:flex sm:items-center justify-between bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
        <div className="sm:flex-auto">
          <h1 className="text-2xl font-semibold text-gray-900">Delivery Tickets</h1>
          {/* <p className="mt-2 text-sm text-gray-700">
            Process and link supplier delivery tickets received via WhatsApp and Email.
          </p> */}
        </div>
        <div className="mt-4 sm:mt-0 flex gap-4 items-center">
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
            className="flex items-center gap-2 bg-[#1B4332] hover:bg-black text-white px-4 py-2 rounded-lg font-medium text-xs transition-all shadow-md disabled:opacity-50"
          >
            {isUploading ? <Loader className="w-4 h-4" /> : <Upload className="w-4 h-4" />}
            {isUploading ? 'Processing...' : 'Upload Ticket Image'}
          </button>
          <button
            onClick={() => pdfInputRef.current?.click()}
            disabled={isUploading}
            className="flex items-center gap-2 bg-[#028090] hover:bg-[#006e7a] text-white px-4 py-2 rounded-lg font-medium text-xs transition-all shadow-md disabled:opacity-50"
          >
            {isUploading ? <Loader className="w-4 h-4" /> : <Upload className="w-4 h-4" />}
            {isUploading ? 'Processing...' : 'Upload ticket PDF'}
          </button>

          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 flex items-center gap-3">
             <div className="bg-yellow-100 p-2 rounded-full">
                <AlertCircle className="w-5 h-5 text-yellow-600" />
             </div>
             <div>
                <p className="text-xs text-yellow-700 font-medium uppercase tracking-wider">Needs Attention</p>
                <p className="text-xl font-bold text-yellow-900">{stats.unlinkedCount} Unlinked</p>
             </div>
          </div>
        </div>
      </div>

      {/* Tabs & Filters */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="border-b border-gray-200">
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
                  relative min-w-0 flex-1 overflow-hidden py-4 px-4 text-sm font-medium text-center hover:bg-gray-50 focus:z-10 transition-colors
                  ${activeTab === tab.id 
                    ? 'text-green-600 border-b-2 border-green-600 bg-green-50/30' 
                    : 'text-gray-500 border-b-2 border-transparent hover:text-gray-700'}
                `}
              >
                <span className="flex items-center justify-center gap-2">
                  {tab.name}
                  {tab.count !== undefined && (
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${activeTab === tab.id ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>
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
            <label className="block text-xs font-medium text-gray-700 mb-1">Search</label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input 
                type="text" 
                placeholder="Ticket #, PO, Material..."
                className="w-full pl-10 pr-4 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>

          <div className="w-48">
            <label className="block text-xs font-medium text-gray-700 mb-1">Supplier</label>
            <select 
              className="w-full p-2 border rounded-lg text-sm bg-white"
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
            <label className="block text-xs font-medium text-gray-700 mb-1">Source</label>
            <select 
              className="w-full p-2 border rounded-lg text-sm"
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
             <label className="block text-xs font-medium text-gray-700 mb-1">Date Range</label>
             <div className="flex items-center gap-1.5">
                <input 
                  type="date" 
                  className="w-full min-w-0 p-2 border rounded-lg text-xs focus:ring-2 focus:ring-green-500 focus:border-green-500 bg-white" 
                  value={startDate} 
                  onChange={e => setStartDate(e.target.value)} 
                />
                <span className="text-gray-400 font-medium">-</span>
                <input 
                  type="date" 
                  className="w-full min-w-0 p-2 border rounded-lg text-xs focus:ring-2 focus:ring-green-500 focus:border-green-500 bg-white" 
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
            className="p-2 text-gray-500 hover:text-gray-700 transition-colors"
            title="Clear Filters"
          >
            <RotateCcw className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Tickets Table */}
      <div className="flex-1 bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden flex flex-col">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50 whitespace-nowrap">
              <tr>
                <th colSpan="2" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Ticket / Image</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Supplier</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Material</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Quantity</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">PO #</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {loading ? (
                <TicketsTableSkeleton />
              ) : tickets.length === 0 ? (
                <tr><td colSpan="8" className="px-6 py-12 text-center text-gray-500">No tickets found.</td></tr>
              ) : (
                tickets.map((ticket) => (
                  <tr key={ticket.id} className="hover:bg-gray-50 transition-colors group">
                    <td className="px-6 py-4 whitespace-nowrap w-20">
                      <div className="w-12 h-12 bg-gray-100 rounded-lg overflow-hidden border border-gray-200 cursor-zoom-in" onClick={() => handleOpenReviewModal(ticket)}>
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
                          <div className="w-full h-full flex items-center justify-center text-gray-400">
                             <FileText className="w-5 h-5" />
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-0 py-4 whitespace-nowrap">
                      <div className="text-sm font-medium text-gray-900 flex items-center gap-2">
                        {ticket.ticketNumber || 'No Ticket #'}
                        {ticket.source === 'WHATSAPP' ? (
                          <Smartphone className="w-3 h-3 text-green-500" title="WhatsApp" />
                        ) : ticket.source === 'EMAIL' ? (
                          <Mail className="w-3 h-3 text-blue-500" title="Email" />
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
                            className="p-1 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded transition-colors"
                            title="Download Ticket Image"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                      <div className="text-xs text-gray-500">{new Date(ticket.receivedAt).toLocaleDateString()}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {ticket.supplier?.name || ticket.supplierName || '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {ticket.material || '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 font-medium">
                      {ticket.quantity ? `${ticket.quantity} ${ticket.unit || 'ton'}` : '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {ticket.poNumber || '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        ticket.status === 'LINKED' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'
                      }`}>
                        {ticket.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <button 
                        onClick={() => handleOpenReviewModal(ticket)}
                        className="text-green-600 hover:text-green-900 bg-green-50 hover:bg-green-100 px-3 py-1.5 rounded-lg transition-colors inline-flex items-center gap-2"
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
        <div className="bg-white px-4 py-3 flex items-center justify-between border-t border-gray-200 sm:px-6">
          <div className="flex-1 flex justify-between sm:hidden">
            <button
              onClick={() => setPage(p => Math.max(p - 1, 1))}
              disabled={page === 1}
              className="relative inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 transition-all"
            >
              Previous
            </button>
            <button
              onClick={() => setPage(p => Math.min(p + 1, totalPages))}
              disabled={page === totalPages}
              className="ml-3 relative inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 transition-all"
            >
              Next
            </button>
          </div>
          <div className="hidden sm:flex-1 sm:flex sm:items-center sm:justify-between">
            <div>
              <p className="text-sm text-gray-700">
                Showing page <span className="font-medium">{page}</span> of{' '}
                <span className="font-medium">{totalPages}</span>
              </p>
            </div>
            <div>
              <nav className="relative z-0 inline-flex rounded-md shadow-sm -space-x-px" aria-label="Pagination">
                <button
                  onClick={() => setPage(p => Math.max(p - 1, 1))}
                  disabled={page === 1}
                  className="relative inline-flex items-center px-2 py-2 rounded-l-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50 transition-all"
                >
                  <span className="sr-only">Previous</span>
                  <ChevronLeft className="h-5 w-5" aria-hidden="true" />
                </button>
                {renderPageNumbers()}
                <button
                  onClick={() => setPage(p => Math.min(p + 1, totalPages))}
                  disabled={page === totalPages}
                  className="relative inline-flex items-center px-2 py-2 rounded-r-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50 transition-all"
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
            <div className="fixed inset-0 bg-gray-600 bg-opacity-75 transition-opacity backdrop-blur-sm"></div>

            <div 
              className="inline-block align-middle bg-white rounded-2xl text-left overflow-hidden shadow-2xl transform transition-all sm:max-w-6xl sm:w-full h-[90vh] flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              
              <div className="flex justify-between items-center px-6 py-4 border-b bg-gray-50">
                <div className="flex items-center gap-3">
                  <h3 className="text-lg font-bold text-gray-900">
                    Ticket Review: {selectedTicket.ticketNumber || 'Unknown'}
                  </h3>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${selectedTicket.status === 'LINKED' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'}`}>
                    {selectedTicket.status}
                  </span>
                  {selectedTicket.driver?.name && (
                    <span className="bg-blue-50 border border-blue-200 text-blue-700 px-2.5 py-0.5 rounded-full text-xs font-semibold" title="Uploaded by Driver">
                      Driver: {selectedTicket.driver.name}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {selectedTicket.imageUrl && (
                    <button
                      type="button"
                      onClick={() => handleDownloadTicketImage(selectedTicket.imageUrl, selectedTicket.ticketNumber)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-gray-200 hover:border-green-300 text-gray-700 hover:text-green-700 rounded-lg text-xs font-semibold shadow-sm transition-all"
                      title="Download Ticket File"
                    >
                      <Download className="w-3.5 h-3.5 text-green-600" />
                      Download
                    </button>
                  )}
                  <button onClick={handleCloseReviewModal} className="text-gray-400 hover:text-gray-600 transition-colors p-1 rounded-full hover:bg-gray-100">
                    <X className="w-6 h-6" />
                  </button>
                </div>
              </div>

              <div className="flex flex-1 overflow-hidden">
                {/* Image Side */}
                <div className="flex-[1.2] bg-gray-900 p-4 flex items-center justify-center overflow-hidden border-r relative group">
                  {selectedTicket.imageUrl ? (
                    selectedTicket.imageUrl.toLowerCase().endsWith('.pdf') ? (
                      <iframe
                        src={selectedTicket.imageUrl.startsWith('http') ? selectedTicket.imageUrl : `${import.meta.env.VITE_API_URL || 'http://localhost:4000'}${selectedTicket.imageUrl}`}
                        className="w-full h-full border-0 bg-white"
                        title="PDF Ticket"
                      />
                    ) : (
                      <img 
                        src={selectedTicket.imageUrl.startsWith('http') ? selectedTicket.imageUrl : `${import.meta.env.VITE_API_URL || 'http://localhost:4000'}${selectedTicket.imageUrl}`} 
                        className="max-w-full max-h-full object-contain shadow-2xl transition-transform duration-300 group-hover:scale-[1.02]"
                        alt="Full ticket"
                      />
                    )
                  ) : (
                    <div className="text-gray-500 flex flex-col items-center">
                       <FileText className="w-16 h-16 mb-2 opacity-20" />
                       No image available
                    </div>
                  )}
                </div>

                {/* Data & Linking Side */}
                <div className="flex-1 overflow-y-auto p-6 bg-white space-y-8">
                  
                  {/* OCR Data Section */}
                  <section>
                    <div className="flex items-center justify-between mb-4">
                      <h4 className="text-sm font-bold text-gray-900 uppercase tracking-widest flex items-center gap-2">
                        <FileText className="w-4 h-4 text-green-600" /> Extracted Information
                      </h4>
                      <p className="text-[10px] text-gray-400 font-medium">VALUES CAN BE MANUALLY OVERRIDDEN</p>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-gray-500 uppercase px-1">Supplier</label>
                        <input 
                          type="text" 
                          className="w-full p-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-green-500 outline-none transition-all"
                          defaultValue={selectedTicket.supplier?.name || selectedTicket.supplierName}
                          onBlur={(e) => handleUpdateTicket(selectedTicket.id, { supplierName: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-gray-500 uppercase px-1">Ticket Date</label>
                        <input 
                          type="date" 
                          className="w-full p-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-green-500 outline-none"
                          defaultValue={selectedTicket.ticketDate ? new Date(selectedTicket.ticketDate).toISOString().split('T')[0] : ''}
                          onBlur={(e) => handleUpdateTicket(selectedTicket.id, { ticketDate: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-gray-500 uppercase px-1">Ticket Number</label>
                        <input 
                          type="text" 
                          className="w-full p-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-green-500 outline-none"
                          defaultValue={selectedTicket.ticketNumber}
                          onBlur={(e) => handleUpdateTicket(selectedTicket.id, { ticketNumber: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-gray-500 uppercase px-1">PO Number</label>
                        <input 
                          type="text" 
                          className="w-full p-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-green-500 outline-none"
                          defaultValue={selectedTicket.poNumber}
                          onBlur={(e) => handleUpdateTicket(selectedTicket.id, { poNumber: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-gray-500 uppercase px-1">Material</label>
                        <input 
                          type="text" 
                          className="w-full p-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-green-500 outline-none"
                          defaultValue={selectedTicket.material}
                          onBlur={(e) => handleUpdateTicket(selectedTicket.id, { material: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-gray-500 uppercase px-1">Quantity</label>
                        <div className="relative">
                          <input 
                            type="number" 
                            className="w-full p-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-green-500 outline-none"
                            defaultValue={selectedTicket.quantity}
                            onBlur={(e) => handleUpdateTicket(selectedTicket.id, { quantity: parseFloat(e.target.value) })}
                          />
                        </div>
                      </div>
                    </div>
                  </section>

                  <hr className="border-gray-100" />

                  {/* Linking Section */}
                  <section className="bg-green-50/50 p-6 rounded-2xl border border-green-100">
                    <div className="flex items-center justify-between mb-4">
                      <h4 className="text-sm font-bold text-gray-900 uppercase tracking-widest flex items-center gap-2">
                        <LinkIcon className="w-4 h-4 text-green-600" /> Linked Orders
                      </h4>
                    </div>

                    <div className="space-y-4">
                      {/* List of currently linked orders */}
                      {(selectedTicket.orderMatches?.length > 0 || selectedTicket.linkedOrder) ? (
                        <div className="space-y-2">
                          <p className="text-[10px] font-bold text-gray-400 uppercase px-1">Linked Records</p>
                          
                          {/* Many-to-many matches */}
                          {selectedTicket.orderMatches?.map(match => (
                            <div key={match.id} className="bg-white p-3 rounded-xl border border-green-200 flex items-center justify-between shadow-sm">
                               <div>
                                  <p className="text-sm font-bold text-gray-900">Spruce ID: {match.order?.spruceOrderId || 'N/A'}</p>
                                  <p className="text-[10px] text-gray-500 uppercase">Customer: {match.order?.customerName || 'Unknown'}</p>
                                  <p className="text-[10px] text-gray-400">Method: {match.matchMethod}</p>
                               </div>
                               <button 
                                onClick={() => handleUnlinkOrder(selectedTicket.id, match.orderId)}
                                className="text-xs text-red-600 hover:bg-red-50 p-2 rounded-lg font-bold transition-colors"
                                title="Unlink Order"
                               >
                                  <X className="w-4 h-4" />
                               </button>
                            </div>
                          ))}

                          {/* Fallback for legacy single-order link if no matches records exist */}
                          {(!selectedTicket.orderMatches || selectedTicket.orderMatches.length === 0) && selectedTicket.linkedOrder && (
                            <div className="bg-white p-3 rounded-xl border border-yellow-200 flex items-center justify-between shadow-sm">
                               <div>
                                  <p className="text-sm font-bold text-gray-900">Spruce ID: {selectedTicket.linkedOrder.spruceOrderId}</p>
                                  <p className="text-[10px] text-gray-500 uppercase">Customer: {selectedTicket.linkedOrder.customerName}</p>
                                  <p className="text-[10px] text-gray-400">Method: {selectedTicket.linkMethod} (Legacy)</p>
                               </div>
                               <button 
                                onClick={() => handleUnlinkOrder(selectedTicket.id, selectedTicket.linkedOrderId)}
                                className="text-xs text-red-600 hover:bg-red-50 p-2 rounded-lg font-bold transition-colors"
                                title="Unlink Order"
                               >
                                  <X className="w-4 h-4" />
                               </button>
                            </div>
                          )}
                        </div>
                      ) : null}

                      {/* Search for more orders to link */}
                      <div className="space-y-3 pt-4 border-t border-gray-100">
                         <p className="text-[10px] font-bold text-gray-400 uppercase px-1">Link {selectedTicket.orderMatches?.length > 0 ? 'Another' : 'an'} Order</p>
                         <div className="relative">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                            <input 
                              type="text" 
                              placeholder="Search Order by PO, Customer, ID..."
                              className="w-full pl-10 pr-4 py-3 bg-white border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-green-500 outline-none shadow-sm"
                              value={orderSearch}
                              onChange={(e) => {
                                setOrderSearch(e.target.value);
                                searchOrders(e.target.value);
                              }}
                            />
                         </div>

                         <div className="space-y-2 max-h-48 overflow-y-auto pr-2 custom-scrollbar">
                            {searchingOrders ? (
                              <div className="text-center py-4 text-gray-400 text-xs italic">Searching available orders...</div>
                            ) : orderResults.length > 0 ? (
                               orderResults.map(order => (
                                 <div key={order.id} className="bg-white p-3 rounded-xl border border-gray-100 flex items-center justify-between hover:border-green-300 transition-all shadow-sm group">
                                    <div className="flex-1">
                                       <p className="text-sm font-bold text-gray-900">{order.customerName}</p>
                                       <p className="text-[10px] text-gray-500 uppercase tracking-tighter">ID: {order.spruceOrderId} | PO: {order.poNumber || 'N/A'}</p>
                                    </div>
                                    <div className="flex items-center gap-3">
                                       <span className="text-xs font-bold text-gray-500">{order.product}</span>
                                       <button 
                                          onClick={() => handleLinkToOrder(selectedTicket.id, order.id)}
                                          className="bg-green-600 text-white p-2 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"
                                          disabled={selectedTicket.orderMatches?.some(m => m.orderId === order.id)}
                                       >
                                          {selectedTicket.orderMatches?.some(m => m.orderId === order.id) ? <CheckCircle className="w-4 h-4" /> : <LinkIcon className="w-4 h-4" />}
                                       </button>
                                    </div>
                                 </div>
                               ))
                            ) : orderSearch ? (
                               <div className="text-center py-4 text-gray-400 text-xs italic">No matching orders found</div>
                            ) : (
                               <div className="text-center py-4 text-gray-400 text-xs italic">Enter search criteria above</div>
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
            <Skeleton variant="rectangle" width="48px" height="48px" className="rounded-lg" />
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
            <Skeleton variant="rectangle" width="80px" height="32px" className="rounded-lg ml-auto" />
          </td>
        </tr>
      ))}
    </>
  );
}
