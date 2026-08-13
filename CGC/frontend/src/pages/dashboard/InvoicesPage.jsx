import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../../api/axios';
import { supabase } from '../../supabaseClient';
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

export default function InvoicesPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('status') || 'ALL';
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef(null);
  const [suppliers, setSuppliers] = useState([]);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({
    supplierId: 'ALL',
    senderType: 'ALL',
    hasDiscrepancies: false,
    dateStart: '',
    dateEnd: ''
  });

  const fetchInvoices = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const params = new URLSearchParams({
        resource: 'invoices',
        limit: '1000'
      });
      if (activeTab !== 'ALL') params.append('status', activeTab);

      const token = localStorage.getItem('token');
      const headers = token ? { Authorization: `Bearer ${token}` } : {};

      const { data, error } = await supabase.functions.invoke(`fetch-cgc-data?${params.toString()}`, {
        method: 'GET',
        headers
      });

      if (error) {
        throw error;
      }

      setInvoices(data && data.data ? data.data : []);
    } catch (err) {
      console.error('Error fetching invoices via Edge Function:', err);
      if (!silent) toast.error('Failed to load invoices');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [activeTab]);

  const fetchSuppliers = useCallback(async () => {
    try {
      const token = localStorage.getItem('token');
      const headers = token ? { Authorization: `Bearer ${token}` } : {};

      const { data, error } = await supabase.functions.invoke('fetch-cgc-data?resource=suppliers&limit=1000', {
        method: 'GET',
        headers
      });

      if (error) throw error;
      setSuppliers(data?.data || []);
    } catch (err) {
      console.error('Error fetching suppliers:', err);
    }
  }, []);

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
    20_000,
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
    } catch (err) {
      toast.error('Upload failed');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const filteredInvoices = invoices
    .filter(inv => {
      const matchesSearch = inv.invoiceNumber?.toLowerCase().includes(search.toLowerCase()) ||
                           inv.supplier?.name?.toLowerCase().includes(search.toLowerCase());

      const matchesSupplier = filters.supplierId === 'ALL' || inv.supplierId === filters.supplierId;
      const matchesType = filters.senderType === 'ALL' || inv.senderType === filters.senderType;
      const flaggedCount = inv.lineItems?.filter(li => li.flag !== 'OK').length || 0;
      const matchesDiscrepancy = !filters.hasDiscrepancies || flaggedCount > 0;

      let matchesDate = true;
      if (filters.dateStart) {
        matchesDate = matchesDate && new Date(inv.invoiceDate || inv.receivedAt) >= new Date(filters.dateStart);
      }
      if (filters.dateEnd) {
        matchesDate = matchesDate && new Date(inv.invoiceDate || inv.receivedAt) <= new Date(filters.dateEnd);
      }

      return matchesSearch && matchesSupplier && matchesType && matchesDiscrepancy && matchesDate;
    })
    .sort((a, b) => {
      const timeA = new Date(a.receivedAt || a.invoiceDate || a.createdAt || 0).getTime();
      const timeB = new Date(b.receivedAt || b.invoiceDate || b.createdAt || 0).getTime();
      if (timeB !== timeA) return timeB - timeA;

      const docTimeA = new Date(a.invoiceDate || 0).getTime();
      const docTimeB = new Date(b.invoiceDate || 0).getTime();
      if (docTimeB !== docTimeA) return docTimeB - docTimeA;

      return String(b.id || '').localeCompare(String(a.id || ''));
    });

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
              {loading ? (
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
                  const flaggedCount = inv.lineItems?.filter(li => li.flag !== 'OK').length || 0;
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
                           <span className="tabular text-[13px] font-medium text-ink">{inv.lineItems?.length || 0}</span>
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
