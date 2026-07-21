import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api/axios';
import { supabase } from '../../supabaseClient';
import { Search, Upload } from 'lucide-react';
import toast from 'react-hot-toast';
import { Skeleton } from '../../components/Skeleton';
import Loader from '../../components/Loader';
import { FadeInUp, StaggerContainer, StaggerItem } from '../../components/Animated';

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

  return (
    <div className="flex flex-col h-full space-y-4">
      <FadeInUp className="sm:flex sm:items-center justify-between bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
        <div className="sm:flex-auto">
          <h1 className="text-2xl font-semibold text-gray-900">Orders</h1>
          <p className="mt-2 text-sm text-gray-700">
            View and import orders via CSV or PDF.
          </p>
        </div>

        <div className="mt-4 sm:ml-16 sm:mt-0 sm:flex-none flex items-center gap-2">
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
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            className="flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg font-medium text-sm transition-colors disabled:opacity-50"
          >
            {isUploading ? (
              <>Processing...</>
            ) : (
              <>
                <Upload className="w-4 h-4" /> Import CSV
              </>
            )}
          </button>
          <button
            onClick={() => pdfInputRef.current?.click()}
            disabled={isUploading}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-medium text-sm transition-colors disabled:opacity-50"
          >
            {isUploading ? (
              <>Processing...</>
            ) : (
              <>
                <Upload className="w-4 h-4" /> Import PDF
              </>
            )}
          </button>
        </div>
      </FadeInUp>

      <FadeInUp delay={0.1} className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm space-y-4">
        <div className="flex flex-wrap gap-4 items-end">
          <div className="w-full sm:w-auto flex-1 min-w-[200px]">
            <label className="block text-xs font-medium text-gray-700 mb-1">Search Text</label>
            <div className="relative rounded-md shadow-sm">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                <Search className="h-4 w-4 text-gray-400" aria-hidden="true" />
              </div>
              <input
                type="text"
                className="block w-full rounded-md border-gray-300 pl-10 focus:border-green-500 focus:ring-green-500 sm:text-sm p-2 border"
                placeholder="Order ID, PO, Customer, Product..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Upload Date</label>
            <div className="flex items-center gap-1 bg-gray-100 p-1 rounded-lg border border-gray-200">
              <button
                type="button"
                onClick={() => setUploadFilter('today')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                  uploadFilter === 'today'
                    ? 'bg-white text-green-700 shadow-sm border border-gray-200/50'
                    : 'text-gray-600 hover:text-gray-950 hover:bg-gray-200/50'
                }`}
              >
                Today
              </button>
              <button
                type="button"
                onClick={() => setUploadFilter('yesterday')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                  uploadFilter === 'yesterday'
                    ? 'bg-white text-green-700 shadow-sm border border-gray-200/50'
                    : 'text-gray-600 hover:text-gray-950 hover:bg-gray-200/50'
                }`}
              >
                Yesterday
              </button>
              <button
                type="button"
                onClick={() => setUploadFilter('select')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                  uploadFilter === 'select'
                    ? 'bg-white text-green-700 shadow-sm border border-gray-200/50'
                    : 'text-gray-600 hover:text-gray-950 hover:bg-gray-200/50'
                }`}
              >
                Select Date
              </button>
            </div>
          </div>

          {uploadFilter === 'select' && (
            <div className="transition-all duration-300">
              <label className="block text-xs font-medium text-gray-700 mb-1">Choose Date</label>
              <input
                type="date"
                className="border border-gray-300 rounded-md sm:text-sm p-2 bg-white text-gray-900 focus:border-green-500 focus:ring-green-500"
                value={selectedUploadDate}
                onChange={(e) => setSelectedUploadDate(e.target.value)}
              />
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Buyer Type</label>
            <select
              className="border-gray-300 rounded-md sm:text-sm p-2 pr-8 border"
              value={buyerType}
              onChange={(e) => { setBuyerType(e.target.value); setPage(1); }}
            >
              <option value="">All Types</option>
              <option value="RETAIL">Retail</option>
              <option value="CONTRACTOR">Contractor</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Has Invoice?</label>
            <select
              className="border-gray-300 rounded-md sm:text-sm p-2 pr-8 border"
              value={hasInvoice}
              onChange={(e) => setHasInvoice(e.target.value)}
            >
              <option value="">Any</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Has Linked Tickets?</label>
            <select
              className="border-gray-300 rounded-md sm:text-sm p-2 pr-8 border"
              value={hasLinkedTickets}
              onChange={(e) => setHasLinkedTickets(e.target.value)}
            >
              <option value="">Any</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Supplier ID</label>
            <input
              type="text"
              placeholder="UUID"
              className="border-gray-300 rounded-md sm:text-sm p-2 border"
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
            />
          </div>
        </div>
      </FadeInUp>

      <div className="flex-1 bg-white rounded-xl border border-gray-200 shadow-sm flex flex-col overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-300">
            <thead className="bg-green-50 sticky top-0">
              <tr>
                <th scope="col" className="py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 sm:pl-6 text-nowrap">
                  Spruce ID
                </th>
                <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                  Customer
                </th>
                <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                  Buyer Type
                </th>
                <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900 text-nowrap">
                  Product
                </th>
                <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                  Quantity
                </th>
                <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                  Supplier
                </th>
                <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                  Order Date
                </th>
                <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                  Tickets
                </th>
                <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900 text-nowrap">
                  Invoice Status
                </th>
              </tr>
            </thead>

            <StaggerContainer component="tbody" className="divide-y divide-gray-200 bg-white">
              {loading ? (
                <OrdersTableSkeleton />
              ) : filteredOrders.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-16 text-center text-sm text-gray-500">
                    <div className="flex flex-col items-center justify-center space-y-2">
                      <p className="text-base font-semibold text-gray-700">
                        {uploadFilter === 'today'
                          ? 'No orders uploaded today'
                          : uploadFilter === 'yesterday'
                          ? 'No orders uploaded yesterday'
                          : selectedUploadDate
                          ? `No orders uploaded on ${new Date(selectedUploadDate + 'T00:00:00').toLocaleDateString(undefined, { dateStyle: 'long' })}`
                          : 'No orders uploaded on this date'}
                      </p>
                      <p className="text-xs text-gray-400">
                        Try importing an order PDF/CSV or changing your date selection.
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredOrders.map((order) => {
                  const hasGaps = !order.poNumber && (!order.ticketMatches || order.ticketMatches.length === 0);

                  return (
                    <StaggerItem
                      key={order.id}
                      component="tr"
                      className={hasGaps ? 'bg-amber-50 hover:bg-amber-100' : 'hover:bg-gray-50'}
                    >
                      <td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm sm:pl-6">
                        <div className="font-medium text-gray-900 flex items-center gap-2">
                          {order.spruceOrderId}
                          {hasGaps && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-200 text-amber-800 uppercase tracking-tighter">
                              Needs Attention
                            </span>
                          )}
                        </div>
                        <div className="text-gray-500 text-xs">
                          PO: {order.poNumber || <span className="text-red-400 italic font-medium">None</span>}
                        </div>
                      </td>

                      <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-900 font-medium">
                        {order.customerName}
                      </td>

                      <td className="whitespace-nowrap px-3 py-4 text-sm">
                        <span
                          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                            order.buyerType === 'CONTRACTOR'
                              ? 'bg-indigo-100 text-indigo-800 border border-indigo-200'
                              : 'bg-green-100 text-green-800 border border-green-200'
                          }`}
                        >
                          {order.buyerType}
                        </span>
                      </td>

                      <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-900">
                        {order.product}
                      </td>

                      <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500 font-medium italic">
                        {order.quantity} {order.unit}
                      </td>

                      <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
                        {order.supplier?.name || '-'}
                      </td>

                      <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
                        {order.orderDate ? new Date(order.orderDate).toLocaleDateString() : '-'}
                      </td>

                      <td className="whitespace-nowrap px-3 py-4 text-sm">
                        <div className="flex -space-x-2 overflow-hidden">
                          {order.ticketMatches?.length > 0 ? (
                            order.ticketMatches.map(match => (
                              <div 
                                key={match.id} 
                                className="inline-block h-8 w-8 rounded-full ring-2 ring-white bg-gray-100 overflow-hidden border border-gray-200" 
                                title={`Ticket: ${match.ticket.ticketNumber || 'N/A'}`}
                              >
                                {match.ticket.imageUrl ? (
                                  <img 
                                    src={match.ticket.imageUrl.startsWith('http') ? match.ticket.imageUrl : `https://cambridge-garden-centre-1.onrender.com${match.ticket.imageUrl}`} 
                                    className="h-full w-full object-cover" 
                                    alt="Ticket"
                                  />
                                ) : (
                                  <div className="h-full w-full flex items-center justify-center bg-gray-200">
                                    <span className="text-[8px] font-bold">T</span>
                                  </div>
                                )}
                              </div>
                            ))
                          ) : (
                            <span className="text-[10px] text-gray-400 italic">No tickets</span>
                          )}
                        </div>
                      </td>

                      <td className="whitespace-nowrap px-3 py-4 text-sm">
                        {order.hasInvoice ? (
                          <div className="flex flex-col">
                            <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-[10px] font-bold uppercase text-green-800 w-fit">
                              Invoiced
                            </span>
                            <span className="text-[10px] text-gray-400 mt-1">
                              {order.invoiceNumber || ''}
                            </span>
                          </div>
                        ) : (
                          <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-[10px] font-bold uppercase text-gray-500">
                            Waiting
                          </span>
                        )}
                      </td>
                    </StaggerItem>
                  );
                })
              )}
            </StaggerContainer>
          </table>
        </div>
      </div>

      {/* Pagination Controls */}
      <div className="flex items-center justify-between bg-white px-4 py-3 sm:px-6 rounded-xl border border-gray-200 shadow-sm">
        <div className="flex flex-1 justify-between sm:hidden">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            className="relative inline-flex items-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Previous
          </button>
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="relative ml-3 inline-flex items-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Next
          </button>
        </div>
        <div className="hidden sm:flex sm:flex-1 sm:items-center sm:justify-between">
          <div>
            <p className="text-sm text-gray-700">
              Showing page <span className="font-medium">{page}</span> <span className="font-medium"> of {totalPages}</span>
            </p>
          </div>
          <div>
            <nav className="isolate inline-flex -space-x-px rounded-md shadow-sm" aria-label="Pagination">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="relative inline-flex items-center rounded-l-md px-3 py-2 text-gray-400 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 focus:z-20 focus:outline-offset-0 disabled:opacity-50"
              >
                Previous
              </button>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="relative inline-flex items-center rounded-r-md px-3 py-2 text-gray-400 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 focus:z-20 focus:outline-offset-0 disabled:opacity-50"
              >
                Next
              </button>
            </nav>
          </div>
        </div>
      </div>
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
            <Skeleton variant="rectangle" width="80px" height="20px" className="rounded-full" />
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
            <Skeleton variant="rectangle" width="40px" height="24px" className="rounded-full" />
          </td>
          <td className="whitespace-nowrap px-3 py-4">
            <Skeleton variant="rectangle" width="70px" height="20px" className="rounded-full" />
          </td>
        </tr>
      ))}
    </>
  );
}