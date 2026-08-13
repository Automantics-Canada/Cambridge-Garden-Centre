import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api/axios';
import { Search, Upload, Inbox } from 'lucide-react';
import toast from 'react-hot-toast';
import { Skeleton } from '../../components/Skeleton';
import { FadeInUp, StaggerContainer, StaggerItem } from '../../components/Animated';
import { ticketThumbnailSrc } from '../../utils/ticketImage';
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

export default function OrdersPage() {
  const [searchParams] = useSearchParams();
  const [orders, setOrders] = useState([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgressText, setUploadProgressText] = useState('');
  const fileInputRef = useRef(null);
  const pdfInputRef = useRef(null);

  const [search, setSearch] = useState('');
  const [buyerType, setBuyerType] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [driverId, setDriverId] = useState(searchParams.get('driverId') || '');
  const [hasInvoice, setHasInvoice] = useState('');
  const [hasLinkedTickets, setHasLinkedTickets] = useState('');
  const [uploadFilter, setUploadFilter] = useState('today'); // 'today' | 'yesterday' | 'select'
  const [selectedUploadDate, setSelectedUploadDate] = useState(''); // 'YYYY-MM-DD'

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    try {
      const apiParams = {
        search,
        buyerType,
        supplierId,
        driverId,
        hasInvoice: hasInvoice === 'yes' ? 'true' : hasInvoice === 'no' ? 'false' : undefined,
        hasLinkedTickets: hasLinkedTickets === 'yes' ? 'true' : hasLinkedTickets === 'no' ? 'false' : undefined,
        limit: 30,
        page
      };

      if (uploadFilter === 'today') {
        const today = new Date();
        const dateStr = today.toISOString().split('T')[0];
        apiParams.uploadStartDate = dateStr;
        apiParams.uploadEndDate = dateStr;
      } else if (uploadFilter === 'yesterday') {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const dateStr = yesterday.toISOString().split('T')[0];
        apiParams.uploadStartDate = dateStr;
        apiParams.uploadEndDate = dateStr;
      } else if (uploadFilter === 'select' && selectedUploadDate) {
        apiParams.uploadStartDate = selectedUploadDate;
        apiParams.uploadEndDate = selectedUploadDate;
      }

      const res = await api.get('/api/orders', { params: apiParams });

      setOrders(res.data?.data || []);
      setTotalPages(res.data?.pagination?.totalPages || 1);
    } catch (err) {
      console.error('Error fetching orders:', err);
      toast.error('Failed to fetch orders');
    } finally {
      setLoading(false);
    }
  }, [search, buyerType, supplierId, driverId, hasInvoice, hasLinkedTickets, uploadFilter, selectedUploadDate, page]);

  const handleFileUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const isCsv = file.name.toLowerCase().endsWith('.csv');
    const isPdf = file.name.toLowerCase().endsWith('.pdf');

    if (!isCsv && !isPdf) {
      toast.error('Please upload a valid CSV or PDF file');
      return;
    }

    const endpoint = isCsv ? '/api/orders/import' : '/api/orders/import-pdf';

    const formData = new FormData();
    formData.append('file', file);

    setIsUploading(true);
    try {
      const res = await api.post(endpoint, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      if (isPdf) {
        const { jobId } = res.data;
        const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:4000';
        const token = localStorage.getItem('token');
        const eventSource = new EventSource(`${baseUrl}/api/orders/import/stream?jobId=${jobId}&token=${token}`);

        let localCreated = 0;
        let localUpdated = 0;
        setUploadProgressText('Connecting to stream...');

        let orderBuffer = [];

        eventSource.onmessage = (e) => {
          const data = JSON.parse(e.data);

          if (data.type === 'progress') {
            if (data.action === 'created') localCreated++;
            if (data.action === 'updated') localUpdated++;
            setUploadProgressText(`Importing... ${localCreated + localUpdated} orders processed`);

            orderBuffer.push(data);

            // Batch UI updates every 10 items for smoother rendering
            if (orderBuffer.length >= 10) {
              const currentBatch = [...orderBuffer];
              orderBuffer = [];

              setOrders(prev => {
                let next = [...prev];
                currentBatch.forEach(bData => {
                  const exists = next.find(o => o.spruceOrderId === bData.order.spruceOrderId);
                  if (exists) {
                    next = next.map(o => o.spruceOrderId === bData.order.spruceOrderId ? bData.order : o);
                  } else if (page === 1) {
                    next = [bData.order, ...next];
                  }
                });
                return page === 1 ? next.slice(0, 30) : next;
              });
            }

          } else if (data.type === 'done') {
            // Flush remaining buffer
            if (orderBuffer.length > 0) {
              setOrders(prev => {
                let next = [...prev];
                orderBuffer.forEach(bData => {
                  const exists = next.find(o => o.spruceOrderId === bData.order.spruceOrderId);
                  if (exists) {
                    next = next.map(o => o.spruceOrderId === bData.order.spruceOrderId ? bData.order : o);
                  } else if (page === 1) {
                    next = [bData.order, ...next];
                  }
                });
                return page === 1 ? next.slice(0, 30) : next;
              });
              orderBuffer = [];
            }

            eventSource.close();
            toast.success(`PDF Import complete! ${data.summary.created} created, ${data.summary.updated} updated.`);
            setIsUploading(false);
            setUploadProgressText('');
            if (page !== 1) setPage(1); // Reset to see new items
          } else if (data.type === 'error') {
            eventSource.close();
            toast.error(`Import error: ${data.error}`);
            setIsUploading(false);
            setUploadProgressText('');
          }
        };

        eventSource.onerror = (e) => {
          console.error('EventSource error:', e);
          eventSource.close();
          toast.error('Lost connection to import stream.');
          setIsUploading(false);
          setUploadProgressText('');
        };
      } else {
        toast.success(
          `Import complete! ${res.data?.created ?? 0} created, ${res.data?.updated ?? 0} updated.`
        );
        setIsUploading(false);
        fetchOrders();
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to import file');
      console.error('Import error:', err);
      setIsUploading(false);
      setUploadProgressText('');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (pdfInputRef.current) pdfInputRef.current.value = '';
    }
  };

  useEffect(() => {
    setPage(1);
  }, [search, buyerType, supplierId, driverId, hasInvoice, hasLinkedTickets, uploadFilter, selectedUploadDate]);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchOrders();
    }, 300);

    return () => clearTimeout(timer);
  }, [fetchOrders]);

  const filteredOrders = orders;

  const emptyTitle =
    uploadFilter === 'today'
      ? 'No orders uploaded today'
      : uploadFilter === 'yesterday'
      ? 'No orders uploaded yesterday'
      : selectedUploadDate
      ? `No orders uploaded on ${new Date(selectedUploadDate + 'T00:00:00').toLocaleDateString(undefined, { dateStyle: 'long' })}`
      : 'No orders uploaded on this date';

  return (
    <div className="flex flex-col h-full space-y-6">
      <FadeInUp>
        <PageHeader
          title="Orders"
          subtitle={uploadProgressText || 'Import Spruce orders, then match them to tickets and invoices.'}
          actions={
            <div className="flex items-center gap-2">
              <input
                type="file"
                accept=".csv"
                ref={fileInputRef}
                onChange={handleFileUpload}
                className="hidden"
              />
              <input
                type="file"
                accept=".pdf"
                ref={pdfInputRef}
                onChange={handleFileUpload}
                className="hidden"
              />
              <Button
                variant="primary"
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading}
              >
                {isUploading ? 'Processing...' : (<><Upload size={16} /> Import CSV</>)}
              </Button>
              <Button
                onClick={() => pdfInputRef.current?.click()}
                disabled={isUploading}
              >
                {isUploading ? 'Processing...' : (<><Upload size={16} /> Import PDF</>)}
              </Button>
            </div>
          }
        />
      </FadeInUp>

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
                  placeholder="Order ID, PO, customer, product..."
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                />
              </div>
            </div>

            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1.5">Upload date</label>
              <div className="flex items-center gap-1 bg-ink/[0.05] p-1 rounded-control">
                {[
                  ['today', 'Today'],
                  ['yesterday', 'Yesterday'],
                  ['select', 'Select date'],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setUploadFilter(id)}
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

            {uploadFilter === 'select' && (
              <div>
                <label className="block text-[12.5px] font-medium text-muted mb-1.5">Choose date</label>
                <Input
                  type="date"
                  className="tabular"
                  value={selectedUploadDate}
                  onChange={(e) => setSelectedUploadDate(e.target.value)}
                />
              </div>
            )}

            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1.5">Buyer type</label>
              <Select
                value={buyerType}
                onChange={(e) => { setBuyerType(e.target.value); setPage(1); }}
              >
                <option value="">All types</option>
                <option value="RETAIL">Retail</option>
                <option value="CONTRACTOR">Contractor</option>
              </Select>
            </div>

            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1.5">Has invoice?</label>
              <Select
                value={hasInvoice}
                onChange={(e) => setHasInvoice(e.target.value)}
              >
                <option value="">Any</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </Select>
            </div>

            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1.5">Has linked tickets?</label>
              <Select
                value={hasLinkedTickets}
                onChange={(e) => setHasLinkedTickets(e.target.value)}
              >
                <option value="">Any</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </Select>
            </div>

            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1.5">Supplier ID</label>
              <Input
                type="text"
                placeholder="UUID"
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
              />
            </div>
          </div>
        </Card>
      </FadeInUp>

      <Card className="flex-1 flex flex-col overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-line">
            <thead className="bg-ink/[0.03] sticky top-0">
              <tr>
                <th scope="col" className="py-3.5 pl-4 pr-3 text-left text-[12.5px] font-semibold text-muted sm:pl-6 text-nowrap">
                  Spruce ID
                </th>
                <th scope="col" className="px-3 py-3.5 text-left text-[12.5px] font-semibold text-muted">
                  Customer
                </th>
                <th scope="col" className="px-3 py-3.5 text-left text-[12.5px] font-semibold text-muted">
                  Buyer type
                </th>
                <th scope="col" className="px-3 py-3.5 text-left text-[12.5px] font-semibold text-muted text-nowrap">
                  Product
                </th>
                <th scope="col" className="px-3 py-3.5 text-left text-[12.5px] font-semibold text-muted">
                  Quantity
                </th>
                <th scope="col" className="px-3 py-3.5 text-left text-[12.5px] font-semibold text-muted">
                  Supplier
                </th>
                <th scope="col" className="px-3 py-3.5 text-left text-[12.5px] font-semibold text-muted">
                  Order date
                </th>
                <th scope="col" className="px-3 py-3.5 text-left text-[12.5px] font-semibold text-muted">
                  Tickets
                </th>
                <th scope="col" className="px-3 py-3.5 text-left text-[12.5px] font-semibold text-muted text-nowrap">
                  Invoice
                </th>
              </tr>
            </thead>

            <StaggerContainer component="tbody" className="divide-y divide-line bg-surface">
              {loading ? (
                <OrdersTableSkeleton />
              ) : filteredOrders.length === 0 ? (
                <tr>
                  <td colSpan={9}>
                    <EmptyState
                      icon={Inbox}
                      title={emptyTitle}
                      message="Import a Spruce CSV or PDF, or pick a different upload date."
                    />
                  </td>
                </tr>
              ) : (
                filteredOrders.map((order) => {
                  const hasGaps = !order.poNumber && (!order.ticketMatches || order.ticketMatches.length === 0);

                  return (
                    <StaggerItem
                      key={order.id}
                      component="tr"
                      className={hasGaps ? 'bg-ochre/10 hover:bg-ochre/15' : 'hover:bg-brand/[0.04]'}
                    >
                      <td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm sm:pl-6">
                        <div className="font-medium text-ink flex items-center gap-2">
                          {order.spruceOrderId}
                          {hasGaps && (
                            <Badge tone="warn">Needs attention</Badge>
                          )}
                        </div>
                        <div className="text-muted text-[13px]">
                          PO: {order.poNumber || <span className="text-clay font-medium">None</span>}
                        </div>
                      </td>

                      <td className="whitespace-nowrap px-3 py-4 text-sm text-ink font-medium">
                        {order.customerName}
                      </td>

                      <td className="whitespace-nowrap px-3 py-4 text-sm">
                        <Badge tone="neutral">{order.buyerType}</Badge>
                      </td>

                      <td className="whitespace-nowrap px-3 py-4 text-sm text-ink">
                        {order.product}
                      </td>

                      <td className="tabular whitespace-nowrap px-3 py-4 text-sm text-muted font-medium">
                        {order.quantity} {order.unit}
                      </td>

                      <td className="whitespace-nowrap px-3 py-4 text-sm text-muted">
                        {order.supplier?.name || '-'}
                      </td>

                      <td className="tabular whitespace-nowrap px-3 py-4 text-sm text-muted">
                        {order.orderDate ? new Date(order.orderDate).toLocaleDateString() : '-'}
                      </td>

                      <td className="whitespace-nowrap px-3 py-4 text-sm">
                        <div className="flex -space-x-2 overflow-hidden">
                          {order.ticketMatches?.length > 0 ? (
                            order.ticketMatches.map(match => (
                              <div
                                key={match.id}
                                className="inline-block h-8 w-8 rounded-pill ring-2 ring-surface bg-ink/[0.06] overflow-hidden border border-line"
                                title={`Ticket: ${match.ticket.ticketNumber || 'N/A'}`}
                              >
                                {match.ticket.imageUrl ? (
                                  <img
                                    src={ticketThumbnailSrc(match.ticket)}
                                    className="h-full w-full object-cover"
                                    alt="Ticket"
                                  />
                                ) : (
                                  <div className="h-full w-full flex items-center justify-center bg-ink/[0.08]">
                                    <span className="text-[12px] font-semibold text-muted">T</span>
                                  </div>
                                )}
                              </div>
                            ))
                          ) : (
                            <span className="text-[12.5px] text-muted">No tickets</span>
                          )}
                        </div>
                      </td>

                      <td className="whitespace-nowrap px-3 py-4 text-sm">
                        {order.hasInvoice ? (
                          <div className="flex flex-col">
                            <Badge tone="good">Invoiced</Badge>
                            <span className="tabular text-[12.5px] text-muted mt-1">
                              {order.invoiceNumber || ''}
                            </span>
                          </div>
                        ) : (
                          <Badge tone="warn">Waiting</Badge>
                        )}
                      </td>
                    </StaggerItem>
                  );
                })
              )}
            </StaggerContainer>
          </table>
        </div>
      </Card>

      <Card className="px-4 py-3 sm:px-6">
        <div className="flex items-center justify-between">
          <div className="flex flex-1 justify-between sm:hidden">
            <Button
              size="sm"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
            >
              Previous
            </Button>
            <Button
              size="sm"
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
            >
              Next
            </Button>
          </div>
          <div className="hidden sm:flex sm:flex-1 sm:items-center sm:justify-between">
            <p className="tabular text-sm text-muted">
              Showing page <span className="font-medium text-ink">{page}</span> of <span className="font-medium text-ink">{totalPages}</span>
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
              >
                Previous
              </Button>
              <Button
                size="sm"
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
              >
                Next
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

function OrdersTableSkeleton() {
  return (
    <>
      {[...Array(10)].map((_, i) => (
        <tr key={i}>
          <td className="whitespace-nowrap py-4 pl-4 pr-3 sm:pl-6">
            <Skeleton variant="text" width="120px" height="16px" />
            <Skeleton variant="text" width="80px" height="12px" className="mt-1" />
          </td>
          <td className="whitespace-nowrap px-3 py-4">
            <Skeleton variant="text" width="140px" height="16px" />
          </td>
          <td className="whitespace-nowrap px-3 py-4">
            <Skeleton variant="rectangle" width="80px" height="20px" className="rounded-pill" />
          </td>
          <td className="whitespace-nowrap px-3 py-4">
            <Skeleton variant="text" width="100px" height="16px" />
          </td>
          <td className="whitespace-nowrap px-3 py-4">
            <Skeleton variant="text" width="60px" height="16px" />
          </td>
          <td className="whitespace-nowrap px-3 py-4">
            <Skeleton variant="text" width="100px" height="16px" />
          </td>
          <td className="whitespace-nowrap px-3 py-4">
            <Skeleton variant="text" width="80px" height="16px" />
          </td>
          <td className="whitespace-nowrap px-3 py-4">
            <Skeleton variant="rectangle" width="40px" height="24px" className="rounded-pill" />
          </td>
          <td className="whitespace-nowrap px-3 py-4">
            <Skeleton variant="rectangle" width="70px" height="20px" className="rounded-pill" />
          </td>
        </tr>
      ))}
    </>
  );
}
