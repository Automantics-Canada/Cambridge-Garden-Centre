import React, { useState, useEffect, useCallback } from 'react';
import api from '../../api/axios';
import { Search } from 'lucide-react';

export default function OrdersPage() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(false);
  
  // Filter states
  const [search, setSearch] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [buyerType, setBuyerType] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [hasInvoice, setHasInvoice] = useState('');
  const [hasLinkedTickets, setHasLinkedTickets] = useState('');

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (search) params.search = search;
      if (startDate) params.startDate = startDate;
      if (endDate) params.endDate = endDate;
      if (buyerType) params.buyerType = buyerType;
      if (supplierId) params.supplierId = supplierId; // Could be a simple text input for name in UI, backend assumes ID. Let's send it anyway. We'll use text input for now.
      if (hasInvoice) params.hasInvoice = hasInvoice === 'yes';
      if (hasLinkedTickets) params.hasLinkedTickets = hasLinkedTickets === 'yes';

      const res = await api.get('/order', { params });
      setOrders(res.data);
    } catch (err) {
      console.error('Error fetching orders:', err);
    } finally {
      setLoading(false);
    }
  }, [search, startDate, endDate, buyerType, supplierId, hasInvoice, hasLinkedTickets]);

  useEffect(() => {
    // Debounce search slightly
    const timer = setTimeout(() => {
      fetchOrders();
    }, 300);
    return () => clearTimeout(timer);
  }, [fetchOrders]);

  return (
    <div className="flex flex-col h-full space-y-4">
      <div className="sm:flex sm:items-center justify-between bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
        <div className="sm:flex-auto">
          <h1 className="text-2xl font-semibold text-gray-900">Orders</h1>
          <p className="mt-2 text-sm text-gray-700">
            Read-only view of all imported Spruce orders.
          </p>
        </div>
      </div>
      
      {/* Filters */}
      <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm space-y-4">
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
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
          
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Date Range</label>
            <div className="flex items-center gap-2">
              <input type="date" className="border-gray-300 rounded-md sm:text-sm p-2 border" value={startDate} onChange={e => setStartDate(e.target.value)}/>
              <span className="text-gray-500">-</span>
              <input type="date" className="border-gray-300 rounded-md sm:text-sm p-2 border" value={endDate} onChange={e => setEndDate(e.target.value)}/>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Buyer Type</label>
            <select className="border-gray-300 rounded-md sm:text-sm p-2 pr-8 border" value={buyerType} onChange={e => setBuyerType(e.target.value)}>
              <option value="">All Types</option>
              <option value="RETAIL">Retail</option>
              <option value="CONTRACTOR">Contractor</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Has Invoice?</label>
            <select className="border-gray-300 rounded-md sm:text-sm p-2 pr-8 border" value={hasInvoice} onChange={e => setHasInvoice(e.target.value)}>
              <option value="">Any</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Has Linked Tickets?</label>
            <select className="border-gray-300 rounded-md sm:text-sm p-2 pr-8 border" value={hasLinkedTickets} onChange={e => setHasLinkedTickets(e.target.value)}>
              <option value="">Any</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </div>

          <div>
             <label className="block text-xs font-medium text-gray-700 mb-1">Supplier ID</label>
             <input type="text" placeholder="UUID" className="border-gray-300 rounded-md sm:text-sm p-2 border" value={supplierId} onChange={e => setSupplierId(e.target.value)} />
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 bg-white rounded-xl border border-gray-200 shadow-sm flex flex-col overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-300">
            <thead className="bg-green-50 sticky top-0">
              <tr>
                <th scope="col" className="py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 sm:pl-6 text-nowrap">Spruce ID</th>
                <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">Customer</th>
                <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">Buyer Type</th>
                <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900 text-nowrap">Product</th>
                <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">Quantity</th>
                <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">Supplier</th>
                <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">Order Date</th>
                <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900 text-nowrap">Invoice Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {loading ? (
                <tr>
                   <td colSpan="8" className="py-12 text-center text-sm text-gray-500">Loading orders...</td>
                </tr>
              ) : orders.length === 0 ? (
                <tr>
                   <td colSpan="8" className="py-12 text-center text-sm text-gray-500">No orders found matching criteria.</td>
                </tr>
              ) : (
                orders.map((order) => (
                  <tr key={order.id} className="hover:bg-gray-50">
                    <td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm sm:pl-6">
                      <div className="font-medium text-gray-900">{order.spruceOrderId}</div>
                      <div className="text-gray-500 text-xs">PO: {order.poNumber || '-'}</div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-900">
                      {order.customerName}
                    </td>
                    <td className="whitespace-nowrap px-3 py-4 text-sm">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        order.buyerType === 'CONTRACTOR' ? 'bg-blue-100 text-blue-800' : 'bg-green-100 text-green-800'
                      }`}>
                        {order.buyerType}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-900">
                      {order.product}
                    </td>
                    <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
                      {order.quantity} {order.unit}
                    </td>
                    <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
                      {order.supplier?.name || '-'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
                      {new Date(order.orderDate).toLocaleDateString()}
                    </td>
                    <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
                      {order.hasInvoice ? (
                        <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">
                          Yes
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-800">
                          No
                        </span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
