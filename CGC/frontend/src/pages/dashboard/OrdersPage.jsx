import React from 'react';

const staticOrders = [
  {
    id: 'ord-001',
    spruceOrderId: 'SORD-100452',
    poNumber: 'PO-98223',
    customerName: 'Toronto Landscaping Co.',
    buyerType: 'CONTRACTOR',
    product: 'Premium Black Mulch',
    quantity: 50,
    unit: 'Cubic Yards',
    orderDate: '2026-03-24',
    deliveryDate: '2026-03-27',
    hasInvoice: true
  },
  {
    id: 'ord-002',
    spruceOrderId: 'SORD-100453',
    poNumber: '-',
    customerName: 'Jane Smith',
    buyerType: 'RETAIL',
    product: 'Topsoil Blend',
    quantity: 5,
    unit: 'Cubic Yards',
    orderDate: '2026-03-25',
    deliveryDate: '2026-03-26',
    hasInvoice: false
  },
  {
    id: 'ord-003',
    spruceOrderId: 'SORD-100454',
    poNumber: 'PO-88211',
    customerName: 'Green Earth Projects',
    buyerType: 'CONTRACTOR',
    product: 'River Rock 1-2"',
    quantity: 20,
    unit: 'Tons',
    orderDate: '2026-03-25',
    deliveryDate: '2026-03-28',
    hasInvoice: true
  },
  {
    id: 'ord-004',
    spruceOrderId: 'SORD-100455',
    poNumber: '-',
    customerName: 'John Doe',
    buyerType: 'RETAIL',
    product: 'Cedar Mulch',
    quantity: 10,
    unit: 'Bags',
    orderDate: '2026-03-26',
    deliveryDate: null,
    hasInvoice: false
  }
];

export default function OrdersPage() {
  return (
    <div>
      <div className="sm:flex sm:items-center">
        <div className="sm:flex-auto">
          <h1 className="text-2xl font-semibold text-gray-900">Orders</h1>
          <p className="mt-2 text-sm text-gray-700">
            A list of all incoming orders, tracking customer details, product requested, and delivery status.
          </p>
        </div>
      </div>
      <div className="mt-8 flex flex-col">
        <div className="-my-2 -mx-4 overflow-x-auto sm:-mx-6 lg:-mx-8">
          <div className="inline-block min-w-full py-2 align-middle md:px-6 lg:px-8">
            <div className="overflow-hidden shadow ring-1 ring-black ring-opacity-5 md:rounded-lg">
              <table className="min-w-full divide-y divide-gray-300">
                <thead className="bg-green-50">
                  <tr>
                    <th scope="col" className="py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 sm:pl-6 text-nowrap">Spruce ID</th>
                    <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">Customer</th>
                    <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900 text-nowrap">Buyer Type</th>
                    <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">Product</th>
                    <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">Quantity</th>
                    <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">Dates</th>
                    <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">Invoice</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {staticOrders.map((order) => (
                    <tr key={order.id} className="hover:bg-gray-50">
                      <td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm sm:pl-6">
                        <div className="font-medium text-gray-900">{order.spruceOrderId}</div>
                        <div className="text-gray-500">PO: {order.poNumber}</div>
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
                        <div className="text-gray-900">Order: {order.orderDate}</div>
                        <div>Deliv: {order.deliveryDate || 'TBD'}</div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
                        {order.hasInvoice ? (
                          <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">
                            Available
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-800">
                            Missing
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
