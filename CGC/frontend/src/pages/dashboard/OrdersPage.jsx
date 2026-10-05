import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api/axios';
import { Search, Upload, Inbox } from 'lucide-react';
import toast from 'react-hot-toast';
import { Skeleton } from '../../components/Skeleton';
import { FadeInUp, StaggerContainer, StaggerItem } from '../../components/Animated';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  PageHeader,
  Select,
} from '../../components/ui';
import { cn } from '../../lib/cn';
import { businessDayOf, businessDayOffset, formatCalendarDate } from '../../lib/date';
import { formatQuantity } from '../../lib/quantity';
import { deliveryTypeLabel, flagBadges } from '../../lib/dispatchBoard';
import { formatDeliveryDay } from '../../lib/dispatchDays';
import {
  DELIVERY_STATUS_OPTIONS,
  deliveryStatusView,
  emptyTitle,
  invoiceSummary,
  uploadRange,
} from '../../lib/orderList';
import SpruceImportPanel from '../../components/orders/SpruceImportPanel';
import OrderEditor from '../../components/orders/OrderEditor';

/**
 * Every Spruce order, one row each, as the three reports merged it: what the
 * import found missing, where the delivery stands, and Edit to fill the gaps.
 * The morning's upload is the day's work, so Today is where it opens.
 */
export default function OrdersPage() {
  const [searchParams] = useSearchParams();
  const [orders, setOrders] = useState([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef(null);
  // The three Spruce reports are imported together; see SpruceImportPanel.
  const [showReportImport, setShowReportImport] = useState(false);
  // The order open in the editor, by id or Spruce number.
  const [editingOrder, setEditingOrder] = useState(null);

  const [search, setSearch] = useState('');
  const [buyerType, setBuyerType] = useState('');
  const [driverId] = useState(searchParams.get('driverId') || '');
  const [hasInvoice, setHasInvoice] = useState('');
  const [hasLinkedTickets, setHasLinkedTickets] = useState('');
  const [fulfilment, setFulfilment] = useState(''); // '' | 'delivery' | 'pickup'
  const [deliveryStatus, setDeliveryStatus] = useState('');
  const [uploadFilter, setUploadFilter] = useState('today'); // 'today' | 'yesterday' | 'all' | 'range'
  const [rangeFrom, setRangeFrom] = useState(''); // 'YYYY-MM-DD'
  const [rangeTo, setRangeTo] = useState('');

  const range = uploadRange({
    filter: uploadFilter,
    from: rangeFrom,
    to: rangeTo,
    today: businessDayOffset(0),
    yesterday: businessDayOffset(-1),
  });
  // A range with no day chosen fetches nothing, rather than every order.
  const awaitingDateChoice = range === null;
  const rangeKey = JSON.stringify(range);

  const fetchOrders = useCallback(async () => {
    if (awaitingDateChoice) {
      setOrders([]);
      setTotal(0);
      setTotalPages(1);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const res = await api.get('/api/orders/documents', {
        params: {
          ...JSON.parse(rangeKey),
          search: search || undefined,
          fulfilment: fulfilment || undefined,
          deliveryStatus: deliveryStatus || undefined,
          buyerType: buyerType || undefined,
          driverId: driverId || undefined,
          hasInvoice: hasInvoice === 'yes' ? 'true' : hasInvoice === 'no' ? 'false' : undefined,
          hasLinkedTickets: hasLinkedTickets === 'yes' ? 'true' : hasLinkedTickets === 'no' ? 'false' : undefined,
          limit: 30,
          page,
        },
      });

      setOrders(res.data?.data || []);
      setTotal(res.data?.pagination?.total || 0);
      setTotalPages(res.data?.pagination?.totalPages || 1);
    } catch (err) {
      console.error('Error fetching orders:', err);
      toast.error(err.response?.data?.error || 'Failed to fetch orders');
    } finally {
      setLoading(false);
    }
  }, [awaitingDateChoice, rangeKey, search, fulfilment, deliveryStatus, buyerType, driverId, hasInvoice, hasLinkedTickets, page]);

  const handleFileUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.csv')) {
      toast.error('Please upload a CSV file. Spruce PDFs go through "Import Spruce reports".');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    const formData = new FormData();
    formData.append('file', file);

    setIsUploading(true);
    try {
      const res = await api.post('/api/orders/import', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success(
        `Import complete! ${res.data?.created ?? 0} created, ${res.data?.updated ?? 0} updated.`
      );
      fetchOrders();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to import file');
      console.error('Import error:', err);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  useEffect(() => {
    setPage(1);
  }, [rangeKey, search, fulfilment, deliveryStatus, buyerType, driverId, hasInvoice, hasLinkedTickets]);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchOrders();
    }, 300);

    return () => clearTimeout(timer);
  }, [fetchOrders]);

  const filtered = Boolean(search || fulfilment || deliveryStatus || buyerType || hasInvoice || hasLinkedTickets);
  const listEmptyTitle = emptyTitle({ filter: uploadFilter, from: rangeFrom, to: rangeTo, filtered });
  const listEmptyMessage = awaitingDateChoice
    ? 'Choose a day, or a first and last day, to see the orders uploaded then.'
    : filtered
      ? 'Clear a filter, or pick other days.'
      : 'Import the Spruce reports, or pick other days.';

  return (
    <div className="flex flex-col h-full space-y-6">
      <FadeInUp>
        <PageHeader
          title="Orders"
          subtitle="Every Spruce order, merged from the three reports. Fill in what is missing with Edit."
          actions={
            <div className="flex items-center gap-2">
              <input
                type="file"
                accept=".csv"
                ref={fileInputRef}
                onChange={handleFileUpload}
                className="hidden"
              />
              <Button
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading}
              >
                {isUploading ? 'Processing...' : (<><Upload size={16} /> Import CSV</>)}
              </Button>
              <Button
                variant="primary"
                onClick={() => setShowReportImport(true)}
                disabled={showReportImport}
              >
                <Upload size={16} /> Import Spruce reports
              </Button>
            </div>
          }
        />
      </FadeInUp>

      {editingOrder && (
        <OrderEditor
          orderRef={editingOrder}
          onClose={() => setEditingOrder(null)}
          onSaved={() => fetchOrders()}
        />
      )}

      {showReportImport && (
        <FadeInUp>
          <SpruceImportPanel
            onClose={() => setShowReportImport(false)}
            onImported={() => { if (page !== 1) setPage(1); else fetchOrders(); }}
            // Most of a morning's issues are a missing address: open the
            // order to fill it in, rather than only finding it.
            onShowOrder={(documentNumber) => setEditingOrder(documentNumber)}
          />
        </FadeInUp>
      )}

      <FadeInUp delay={0.1}>
        <Card className="p-4 space-y-4">
          <div className="flex flex-wrap gap-4 items-end">
            <div className="w-full sm:w-auto flex-1 min-w-[200px]">
              <label className="block text-[12.5px] font-medium text-muted mb-1.5">Search</label>
              <div className="relative">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                  <Search className="h-4 w-4 text-muted" aria-hidden="true" />
                </div>
                <Input
                  type="text"
                  className="pl-10"
                  placeholder="Order #, customer, PO, address, product..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>

            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1.5">Upload date</label>
              <div className="flex items-center gap-1 bg-ink/[0.05] p-1 rounded-control">
                {[
                  ['today', 'Today'],
                  ['yesterday', 'Yesterday'],
                  ['all', 'All'],
                  ['range', 'Pick dates'],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setUploadFilter(id)}
                    aria-pressed={uploadFilter === id}
                    className={cn(
                      'px-3 py-1.5 rounded-control text-[13px] font-semibold transition-colors',
                      uploadFilter === id
                        ? 'bg-surface text-brand shadow-card border border-line'
                        : 'text-muted hover:text-ink'
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {uploadFilter === 'range' && (
              <>
                <div>
                  <label className="block text-[12.5px] font-medium text-muted mb-1.5">From</label>
                  <Input
                    type="date"
                    className="tabular"
                    aria-label="First upload day"
                    value={rangeFrom}
                    onChange={(e) => setRangeFrom(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-[12.5px] font-medium text-muted mb-1.5">To</label>
                  <Input
                    type="date"
                    className="tabular"
                    aria-label="Last upload day"
                    value={rangeTo}
                    onChange={(e) => setRangeTo(e.target.value)}
                  />
                </div>
              </>
            )}

            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1.5">Delivery status</label>
              <Select value={deliveryStatus} onChange={(e) => setDeliveryStatus(e.target.value)}>
                {DELIVERY_STATUS_OPTIONS.map(({ value, label }) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </Select>
            </div>

            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1.5">Delivery or pickup</label>
              <Select value={fulfilment} onChange={(e) => setFulfilment(e.target.value)}>
                <option value="">Both</option>
                <option value="delivery">Delivery</option>
                <option value="pickup">Pickup</option>
              </Select>
            </div>

            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1.5">Buyer type</label>
              <Select value={buyerType} onChange={(e) => setBuyerType(e.target.value)}>
                <option value="">All types</option>
                <option value="RETAIL">Retail</option>
                <option value="CONTRACTOR">Contractor</option>
              </Select>
            </div>

            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1.5">Invoiced?</label>
              <Select value={hasInvoice} onChange={(e) => setHasInvoice(e.target.value)}>
                <option value="">Any</option>
                <option value="yes">Fully</option>
                <option value="no">Not fully</option>
              </Select>
            </div>

            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1.5">Has linked tickets?</label>
              <Select value={hasLinkedTickets} onChange={(e) => setHasLinkedTickets(e.target.value)}>
                <option value="">Any</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </Select>
            </div>
          </div>
        </Card>
      </FadeInUp>

      <Card className="flex-1 flex flex-col overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-line">
            <thead className="bg-ink/[0.03] sticky top-0">
              <tr>
                <th scope="col" className="py-3.5 pl-4 pr-3 text-left text-[12.5px] font-semibold text-muted sm:pl-6 text-nowrap">Order</th>
                <th scope="col" className="px-3 py-3.5 text-left text-[12.5px] font-semibold text-muted">Customer</th>
                <th scope="col" className="px-3 py-3.5 text-left text-[12.5px] font-semibold text-muted">Type</th>
                <th scope="col" className="px-3 py-3.5 text-left text-[12.5px] font-semibold text-muted">Products</th>
                <th scope="col" className="px-3 py-3.5 text-left text-[12.5px] font-semibold text-muted text-nowrap">Delivery date</th>
                <th scope="col" className="px-3 py-3.5 text-left text-[12.5px] font-semibold text-muted">Missing or to check</th>
                <th scope="col" className="px-3 py-3.5 text-left text-[12.5px] font-semibold text-muted text-nowrap">Delivery status</th>
                <th scope="col" className="px-3 py-3.5 text-left text-[12.5px] font-semibold text-muted text-nowrap">Tickets &amp; invoice</th>
                <th scope="col" className="relative py-3.5 pl-3 pr-4 sm:pr-6">
                  <span className="sr-only">Edit</span>
                </th>
              </tr>
            </thead>

            <StaggerContainer component="tbody" className="divide-y divide-line bg-surface">
              {loading ? (
                <OrdersTableSkeleton />
              ) : orders.length === 0 ? (
                <tr>
                  <td colSpan={9}>
                    <EmptyState icon={Inbox} title={listEmptyTitle} message={listEmptyMessage} />
                  </td>
                </tr>
              ) : (
                orders.map((order) => <OrderRow key={order.id} order={order} onEdit={setEditingOrder} />)
              )}
            </StaggerContainer>
          </table>
        </div>
      </Card>

      <Card className="px-4 py-3 sm:px-6">
        <div className="flex items-center justify-between">
          <div className="flex flex-1 justify-between sm:hidden">
            <Button size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>
              Previous
            </Button>
            <Button size="sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>
              Next
            </Button>
          </div>
          <div className="hidden sm:flex sm:flex-1 sm:items-center sm:justify-between">
            <p className="tabular text-sm text-muted">
              <span className="font-medium text-ink">{total}</span> order{total === 1 ? '' : 's'} · page <span className="font-medium text-ink">{page}</span> of <span className="font-medium text-ink">{totalPages}</span>
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>
                Previous
              </Button>
              <Button size="sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>
                Next
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

/** One Spruce order, merged from the three reports. */
function OrderRow({ order, onEdit }) {
  const badges = flagBadges(order);
  const status = deliveryStatusView(order);
  const invoice = invoiceSummary(order);
  const type = deliveryTypeLabel(order.deliveryType);
  const needsLook = badges.some(({ tone }) => tone === 'bad' || tone === 'warn');

  return (
    <StaggerItem
      component="tr"
      className={needsLook ? 'bg-ochre/10 hover:bg-ochre/15' : 'hover:bg-brand/[0.04]'}
    >
      <td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm sm:pl-6 align-top">
        <div className="font-semibold text-ink tabular">{order.spruceOrderId}</div>
        <div className="text-muted text-[12.5px]">
          PO: {order.poNumbers?.length > 0 ? order.poNumbers.join(', ') : <span className="text-clay font-medium">None</span>}
        </div>
        {/* Cambridge's day, the one the Upload date filter counts in. */}
        <div className="text-muted text-[12px] tabular">Uploaded {formatCalendarDate(businessDayOf(new Date(order.uploadedAt)))}</div>
      </td>

      <td className="px-3 py-4 text-sm align-top min-w-[200px]">
        <div className="font-medium text-ink">{order.customerName}</div>
        {!order.isPickup && (
          <div className={cn('text-[12.5px]', order.address ? 'text-muted' : 'text-clay font-semibold')}>
            {order.address || 'No address'}
          </div>
        )}
        {order.phone && <div className="text-muted text-[12.5px] tabular">{order.phone}</div>}
      </td>

      <td className="whitespace-nowrap px-3 py-4 text-sm align-top">
        <div className="flex flex-col items-start gap-1">
          {order.isPickup ? <Badge tone="neutral">Pickup</Badge> : <Badge tone="good">Delivery</Badge>}
          {!order.isPickup && type && <span className="text-[12.5px] text-muted">{type}</span>}
        </div>
      </td>

      <td className="px-3 py-4 text-sm align-top min-w-[180px]">
        <div className="text-ink">{order.product}</div>
        {order.quantity !== null && order.quantity !== undefined && (
          <div className="text-muted text-[12.5px] tabular">{formatQuantity(order.quantity, order.unit)}</div>
        )}
      </td>

      <td className="whitespace-nowrap px-3 py-4 text-sm text-muted tabular align-top">
        {order.deliveryDate ? formatDeliveryDay(order.deliveryDate) : (order.isPickup ? '—' : <span className="text-clay font-medium">No date</span>)}
      </td>

      <td className="px-3 py-4 text-sm align-top min-w-[160px]">
        {badges.length === 0 && !order.edited ? (
          <span className="text-[12.5px] text-muted">Nothing missing</span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {order.edited && <Badge tone="neutral">Edited</Badge>}
            {badges.map(({ flag, label, tone }) => (
              <Badge key={flag} tone={tone}>{label}</Badge>
            ))}
          </div>
        )}
      </td>

      <td className="whitespace-nowrap px-3 py-4 text-sm align-top">
        <Badge tone={status.tone}>{status.label}</Badge>
        {status.detail && <div className="mt-1 text-[12.5px] text-muted">{status.detail}</div>}
      </td>

      <td className="whitespace-nowrap px-3 py-4 text-sm align-top">
        <div className="flex flex-col items-start gap-1">
          <Badge tone={invoice.tone}>{invoice.label}</Badge>
          <span className="text-[12.5px] text-muted">
            {order.ticketCount > 0 ? `${order.ticketCount} ticket${order.ticketCount === 1 ? '' : 's'}` : 'No tickets'}
          </span>
        </div>
      </td>

      <td className="whitespace-nowrap py-4 pl-3 pr-4 text-right text-sm sm:pr-6 align-top">
        <Button size="sm" onClick={() => onEdit(order.id)}>Edit</Button>
      </td>
    </StaggerItem>
  );
}

function OrdersTableSkeleton() {
  return (
    <>
      {[...Array(8)].map((_, i) => (
        <tr key={i}>
          <td className="whitespace-nowrap py-4 pl-4 pr-3 sm:pl-6">
            <Skeleton variant="text" width="110px" height="16px" />
            <Skeleton variant="text" width="80px" height="12px" className="mt-1" />
          </td>
          <td className="px-3 py-4">
            <Skeleton variant="text" width="150px" height="16px" />
            <Skeleton variant="text" width="120px" height="12px" className="mt-1" />
          </td>
          <td className="px-3 py-4">
            <Skeleton variant="rectangle" width="64px" height="20px" className="rounded-pill" />
          </td>
          <td className="px-3 py-4">
            <Skeleton variant="text" width="130px" height="16px" />
          </td>
          <td className="px-3 py-4">
            <Skeleton variant="text" width="80px" height="16px" />
          </td>
          <td className="px-3 py-4">
            <Skeleton variant="rectangle" width="90px" height="20px" className="rounded-pill" />
          </td>
          <td className="px-3 py-4">
            <Skeleton variant="rectangle" width="90px" height="20px" className="rounded-pill" />
          </td>
          <td className="px-3 py-4">
            <Skeleton variant="rectangle" width="80px" height="20px" className="rounded-pill" />
          </td>
          <td className="py-4 pl-3 pr-4 sm:pr-6">
            <Skeleton variant="rectangle" width="48px" height="28px" className="rounded-control ml-auto" />
          </td>
        </tr>
      ))}
    </>
  );
}
