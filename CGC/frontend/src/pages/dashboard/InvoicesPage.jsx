import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useSelector } from 'react-redux';
import api from '../../api/axios';
import {
  getCachedInvoicePage,
  loadInvoicePage,
  loadSupplierOptions,
} from '../../data/routeData';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import {
  Search,
  Upload,
  FileText,
  AlertTriangle,
  ChevronRight,
  Inbox,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { Skeleton } from '../../components/Skeleton';
import { useIntervalRefresh } from '../../hooks/useIntervalRefresh';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  PageHeader,
  Select,
  StatusBadge,
} from '../../components/ui';
import { cn } from '../../lib/cn';
import { formatDate } from '../../lib/date';

const STATUS_TABS = [
  { id: 'ALL', name: 'All invoices' },
  { id: 'PENDING_REVIEW', name: 'Pending review' },
  { id: 'VERIFIED', name: 'Verified' },
  { id: 'DISPUTED', name: 'Disputed' }
];

const INVOICES_PER_PAGE = 25;

export default function InvoicesPage() {
  const navigate = useNavigate();
  const userId = useSelector((state) => state.auth.user?.id);
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('status') || 'ALL';
  const [invoices, setInvoices] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, totalCount: 0 });
  const [page, setPage] = useState(1);
  const [loadError, setLoadError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef(null);
  const [suppliers, setSuppliers] = useState([]);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 350);
  const [filters, setFilters] = useState({
    supplierId: 'ALL',
    senderType: 'ALL',
    hasDiscrepancies: false,
    dateStart: '',
    dateEnd: ''
  });

  // Narrowing the result set can leave the current page out of range, so the
  // page resets whenever a filter changes. This is done during render rather
  // than in an effect: an effect would let one render commit with the old page
  // and the new filter, firing a request for a page the user never asked for.
  const filterSignature = JSON.stringify([activeTab, filters, debouncedSearch]);
  const [lastFilterSignature, setLastFilterSignature] = useState(filterSignature);
  if (filterSignature !== lastFilterSignature) {
    setLastFilterSignature(filterSignature);
    setPage(1);
  }

  // Every filter is a server-side parameter. This screen previously pulled
  // `limit=1000` invoices plus every supplier and negotiated rate from the Edge
  // function and filtered them in the browser, then repeated the whole download
  // every 20 seconds.
  const query = useMemo(() => ({
    page,
    limit: INVOICES_PER_PAGE,
    status: activeTab === 'ALL' ? undefined : activeTab,
    supplierId: filters.supplierId === 'ALL' ? undefined : filters.supplierId,
    senderType: filters.senderType === 'ALL' ? undefined : filters.senderType,
    flaggedOnly: filters.hasDiscrepancies || undefined,
    startDate: filters.dateStart || undefined,
    endDate: filters.dateEnd || undefined,
    search: debouncedSearch || undefined,
  }), [page, activeTab, filters, debouncedSearch]);

  const fetchInvoices = useCallback(async (silent = false) => {
    const cached = getCachedInvoicePage(userId, query);
    if (cached) {
      setInvoices(cached.data);
      setPagination(cached.pagination);
      setLoading(false);
    } else if (!silent) {
      setLoading(true);
    }

    try {
      const result = await loadInvoicePage(userId, query, { force: true });
      setInvoices(result.data);
      setPagination(result.pagination);
      setLoadError(null);
    } catch (err) {
      // A background refresh that fails must not blank the table the user is
      // reading; it only surfaces the banner.
      setLoadError(err);
    } finally {
      setLoading(false);
    }
  }, [userId, query]);

  const fetchSuppliers = useCallback(async () => {
    try {
      setSuppliers(await loadSupplierOptions(userId));
    } catch (err) {
      // The dropdown degrades to "All suppliers"; the table is still usable.
      console.error('Error fetching supplier options:', err);
    }
  }, [userId]);

  useEffect(() => {
    fetchInvoices();
  }, [fetchInvoices]);

  useEffect(() => {
    fetchSuppliers();
  }, [fetchSuppliers]);

  const fetchInvoicesRef = useRef(fetchInvoices);

  useEffect(() => {
    fetchInvoicesRef.current = fetchInvoices;
  }, [fetchInvoices]);

  useIntervalRefresh(
    () => {
      fetchInvoicesRef.current(true);
    },
    60_000,
    { enabled: !isUploading }
  );

  const handleFileUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.name.match(/\.(jpg|jpeg|png|pdf)$/i)) {
      toast.error('Please upload a valid JPG, PNG, or PDF file');
      return;
    }

    const formData = new FormData();
    formData.append('file', file);

    setIsUploading(true);
    try {
      const res = await api.post('/api/invoices/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success('Invoice uploaded and processing!');
      fetchInvoices();
      // Optionally navigate to the detail page immediately
      if (res.data.invoice?.id) {
         navigate(`/dashboard/invoices/${res.data.invoice.id}`);
      }
    } catch {
      toast.error('Upload failed');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Filtered, sorted and paged by Postgres — see InvoiceService.getInvoices.
  const filteredInvoices = invoices;
  const totalPages = Math.max(pagination.totalPages || 1, 1);
  const totalCount = pagination.totalCount ?? invoices.length;

  return (
    <div className="flex flex-col h-full space-y-6">
      <PageHeader
        title="Invoices"
        subtitle="Review incoming invoices and check them against the agreed rates."
        actions={
          <>
            <input
              type="file"
              accept=".jpg,.jpeg,.png,.pdf"
              ref={fileInputRef}
              onChange={handleFileUpload}
              className="hidden"
            />
            <Button
              variant="primary"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
            >
              {isUploading ? (
                <div className="w-4 h-4 border-2 border-on-brand border-t-transparent rounded-pill animate-spin" />
              ) : (
                <Upload size={16} />
              )}
              {isUploading ? 'Processing...' : 'Upload invoice'}
            </Button>
          </>
        }
      />

      <Card className="overflow-hidden">
        <nav className="flex border-b border-line" aria-label="Tabs">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => {
                const newParams = new URLSearchParams(searchParams);
                if (tab.id === 'ALL') {
                  newParams.delete('status');
                } else {
                  newParams.set('status', tab.id);
                }
                setSearchParams(newParams, { replace: true });
              }}
              className={cn(
                'flex-1 py-4 px-4 text-sm font-medium text-center border-b-2 transition-colors',
                activeTab === tab.id
                  ? 'text-brand border-brand bg-brand/[0.04]'
                  : 'text-muted border-transparent hover:text-ink hover:bg-ink/[0.03]'
              )}
            >
              {tab.name}
            </button>
          ))}
        </nav>

        <div className="p-4 flex flex-wrap gap-4 items-end">
          <div className="flex-1 min-w-[240px]">
            <label className="block text-[12.5px] font-medium text-muted mb-1.5">Search</label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
              <Input
                type="text"
                placeholder="Invoice number or supplier..."
                className="pl-10"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
          </div>

          <div className="w-48">
            <label className="block text-[12.5px] font-medium text-muted mb-1.5">Supplier</label>
            <Select
              value={filters.supplierId}
              onChange={e => setFilters({...filters, supplierId: e.target.value})}
            >
              <option value="ALL">All suppliers</option>
              {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </div>

          <div className="w-40">
            <label className="block text-[12.5px] font-medium text-muted mb-1.5">Type</label>
            <Select
              value={filters.senderType}
              onChange={e => setFilters({...filters, senderType: e.target.value})}
            >
              <option value="ALL">All types</option>
              <option value="SUPPLIER">Supplier</option>
              <option value="TRUCKING_COMPANY">Trucking</option>
            </Select>
          </div>

          <div className="flex gap-2 items-end">
            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1.5">From</label>
              <Input
                type="date"
                className="tabular"
                value={filters.dateStart}
                onChange={e => setFilters({...filters, dateStart: e.target.value})}
              />
            </div>
            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1.5">To</label>
              <Input
                type="date"
                className="tabular"
                value={filters.dateEnd}
                onChange={e => setFilters({...filters, dateEnd: e.target.value})}
              />
            </div>
          </div>

          <div className="flex items-center gap-2 pb-2">
            <input
              type="checkbox"
              id="discrepancy"
              className="w-4 h-4 rounded border-line text-brand accent-brand"
              checked={filters.hasDiscrepancies}
              onChange={e => setFilters({...filters, hasDiscrepancies: e.target.checked})}
            />
            <label htmlFor="discrepancy" className="text-sm font-medium text-ink">Flagged only</label>
          </div>
        </div>
      </Card>

      {loadError && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-card border border-clay/30 bg-clay/[0.06] px-5 py-4"
        >
          <AlertTriangle className="h-5 w-5 flex-none text-clay" />
          <p className="flex-1 text-[13.5px] text-ink">
            {loadError.message} {invoices.length > 0 && 'Showing the last loaded page.'}
          </p>
          <button
            type="button"
            onClick={() => fetchInvoices()}
            className="rounded-control border border-line px-3 py-2 text-[12.5px] font-semibold text-ink transition-colors hover:border-brand/40 hover:bg-brand/[0.04]"
          >
            Try again
          </button>
        </div>
      )}

      <Card className="flex-1 overflow-hidden flex flex-col">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-line">
            <thead className="bg-ink/[0.03] sticky top-0">
              <tr>
                <th className="px-6 py-3 text-left text-[12.5px] font-semibold text-muted">Invoice</th>
                <th className="px-6 py-3 text-left text-[12.5px] font-semibold text-muted">Supplier</th>
                <th className="px-6 py-3 text-left text-[12.5px] font-semibold text-muted">Date</th>
                <th className="px-6 py-3 text-left text-[12.5px] font-semibold text-muted">Total</th>
                <th className="px-6 py-3 text-left text-[12.5px] font-semibold text-muted text-center">Lines</th>
                <th className="px-6 py-3 text-left text-[12.5px] font-semibold text-muted">Status</th>
                <th className="px-6 py-3 text-right text-[12.5px] font-semibold text-muted">Action</th>
              </tr>
            </thead>
            <tbody className="bg-surface divide-y divide-line">
              {loading && filteredInvoices.length === 0 ? (
                <InvoicesTableSkeleton />
              ) : filteredInvoices.length === 0 ? (
                <tr>
                  <td colSpan="7">
                    <EmptyState
                      icon={Inbox}
                      title="No invoices match"
                      message="Try another status, search, or date range — or upload an invoice to get started."
                    />
                  </td>
                </tr>
              ) : (
                filteredInvoices.map((inv) => {
                  const flaggedCount = inv.flaggedCount || 0;
                  return (
                    <tr
                      key={inv.id}
                      className="hover:bg-brand/[0.04] transition-colors cursor-pointer group"
                      onClick={() => navigate(`/dashboard/invoices/${inv.id}`)}
                    >
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center gap-3">
                           <div className="p-2 bg-ink/[0.05] rounded-control group-hover:bg-brand/10 transition-colors">
                              <FileText className="w-5 h-5 text-muted group-hover:text-brand" />
                           </div>
                           <div className="text-sm font-semibold text-ink">{inv.invoiceNumber}</div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-muted font-medium">
                        {inv.supplier?.name || '-'}
                      </td>
                      <td className="tabular px-6 py-4 whitespace-nowrap text-sm text-muted">
                        {formatDate(inv.invoiceDate)}
                      </td>
                      <td className="tabular px-6 py-4 whitespace-nowrap text-sm font-semibold text-ink">
                        ${Number(inv.totalAmount).toFixed(2)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-center">
                        <div className="flex items-center justify-center gap-2">
                           <span className="tabular text-[13px] font-medium text-ink">{inv.lineItemCount || 0}</span>
                           {flaggedCount > 0 && (
                             <Badge tone="bad" className="gap-1">
                               <AlertTriangle className="w-3 h-3" /> {flaggedCount}
                             </Badge>
                           )}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <StatusBadge status={inv.status} />
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <button className="text-muted group-hover:text-brand transition-colors p-2 rounded-control group-hover:bg-brand/10">
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

        {totalCount > 0 && (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-t border-line px-5 py-3">
            <p className="text-[12.5px] text-muted" aria-live="polite">
              Showing {(page - 1) * INVOICES_PER_PAGE + 1}–
              {Math.min((page - 1) * INVOICES_PER_PAGE + invoices.length, totalCount)} of {totalCount} invoices
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPage(current => Math.max(1, current - 1))}
                disabled={page <= 1 || loading}
              >
                Previous
              </Button>
              <span className="min-w-20 text-center text-[12.5px] font-medium text-muted">
                {loading ? 'Loading…' : `${page} / ${totalPages}`}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPage(current => Math.min(totalPages, current + 1))}
                disabled={page >= totalPages || loading}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
function InvoicesTableSkeleton() {
  return (
    <>
      {[...Array(10)].map((_, i) => (
        <tr key={i}>
          <td className="px-6 py-4 whitespace-nowrap">
            <div className="flex items-center gap-3">
              <Skeleton variant="rectangle" width="32px" height="32px" className="rounded-control" />
              <Skeleton variant="text" width="100px" height="16px" />
            </div>
          </td>
          <td className="px-6 py-4 whitespace-nowrap">
            <Skeleton variant="text" width="120px" height="16px" />
          </td>
          <td className="px-6 py-4 whitespace-nowrap">
            <Skeleton variant="text" width="80px" height="16px" />
          </td>
          <td className="px-6 py-4 whitespace-nowrap">
            <Skeleton variant="text" width="80px" height="16px" />
          </td>
          <td className="px-6 py-4 whitespace-nowrap">
            <div className="flex justify-center">
              <Skeleton variant="text" width="30px" height="16px" />
            </div>
          </td>
          <td className="px-6 py-4 whitespace-nowrap">
            <Skeleton variant="rectangle" width="80px" height="20px" className="rounded-pill" />
          </td>
          <td className="px-6 py-4 whitespace-nowrap text-right">
            <Skeleton variant="rectangle" width="32px" height="32px" className="rounded-control ml-auto" />
          </td>
        </tr>
      ))}
    </>
  );
}
