import React, { useState, useEffect } from 'react';
import api from '../../api/axios';
import { Truck, MapPin, Search } from 'lucide-react';

import { DispatchBoardSkeleton } from '../../components/Skeleton';

export default function DispatchBoard() {
  const [board, setBoard] = useState({ unassignedOrders: [], unassignedDeliveries: [], drivers: [] });
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('unassigned');

  const fetchBoard = async () => {
    try {
      setLoading(true);
      const res = await api.get('/api/dispatch');
      setBoard(res.data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBoard();
  }, []);

  const handleAssign = async (orderId, driverId, priority = 1) => {
    try {
      await api.post('/api/dispatch/assign', { orderId, driverId, priority });
      fetchBoard();
    } catch (e) {
      console.error('Assign failed', e);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Dispatch Board</h1>
        <p className="text-sm text-gray-500">Manage daily assignments and track driver workflows.</p>
      </div>

      <div className="flex gap-4 border-b border-gray-200">
        <button
          className={`pb-3 font-semibold text-sm transition-colors ${activeTab === 'unassigned' ? 'border-b-2 border-[#2D6A4F] text-[#2D6A4F]' : 'text-gray-500 hover:text-gray-700'}`}
          onClick={() => setActiveTab('unassigned')}
        >
          Unassigned Orders ({board.unassignedOrders.length})
        </button>
        <button
          className={`pb-3 font-semibold text-sm transition-colors ${activeTab === 'assigned' ? 'border-b-2 border-[#2D6A4F] text-[#2D6A4F]' : 'text-gray-500 hover:text-gray-700'}`}
          onClick={() => setActiveTab('assigned')}
        >
          Assigned Drivers ({board.drivers.length})
        </button>
      </div>

      {loading ? (
        <DispatchBoardSkeleton activeTab={activeTab} />
      ) : activeTab === 'unassigned' ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 text-gray-500">
              <tr>
                <th className="px-6 py-3 font-medium">Order ID</th>
                <th className="px-6 py-3 font-medium">Customer</th>
                <th className="px-6 py-3 font-medium">Material</th>
                <th className="px-6 py-3 font-medium text-right">Assign Driver</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {board.unassignedOrders.map(order => (
                <tr key={order.id} className="hover:bg-gray-50/50">
                  <td className="px-6 py-4 font-medium text-gray-900">{order.spruceOrderId}</td>
                  <td className="px-6 py-4 text-gray-600">{order.customerName}</td>
                  <td className="px-6 py-4 text-gray-600">{Number(order.quantity)} {order.unit} {order.product}</td>
                  <td className="px-6 py-4 text-right">
                    <select
                      className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white"
                      onChange={(e) => {
                        if(e.target.value) handleAssign(order.id, e.target.value);
                      }}
                      defaultValue=""
                    >
                      <option value="" disabled>Select Driver...</option>
                      {board.drivers.map(d => (
                        <option key={d.id} value={d.id}>{d.name} ({d.type === 'CGC_FLEET' ? 'Fleet' : 'Ind.'})</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
              {board.unassignedOrders.length === 0 && (
                <tr><td colSpan="4" className="px-6 py-8 text-center text-gray-500">No unassigned orders</td></tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {board.drivers.map(driver => (
            <div key={driver.id} className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
              <div className="bg-gray-50 px-5 py-4 border-b border-gray-100 flex justify-between items-center">
                <div>
                  <h3 className="font-bold text-gray-900 flex items-center gap-2">
                    <Truck size={16} className="text-[#2D6A4F]" />
                    {driver.name}
                  </h3>
                  <p className="text-xs text-gray-500">{driver.type === 'CGC_FLEET' ? 'CGC Fleet' : 'Independent'} • ${driver.ratePerTrip}/trip</p>
                </div>
                <div className="text-right">
                  <span className="text-sm font-bold text-gray-900">{driver.todayDeliveries}</span>
                  <span className="text-xs text-gray-500 ml-1">Assigned</span>
                </div>
              </div>
              <div className="divide-y divide-gray-100 max-h-[300px] overflow-y-auto">
                {driver.deliveries.length === 0 ? (
                  <div className="p-4 text-center text-sm text-gray-500">No deliveries assigned today</div>
                ) : (
                  driver.deliveries.map(del => (
                    <div key={del.id} className="p-4 hover:bg-gray-50 transition-colors">
                      <div className="flex justify-between items-start mb-2">
                        <span className="font-semibold text-gray-900 text-sm">{del.order.spruceOrderId}</span>
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-tight
                          ${del.status === 'DELIVERED' ? 'bg-green-100 text-green-700' :
                            del.status === 'IN_TRANSIT' ? 'bg-amber-100 text-amber-700' :
                            del.status === 'PICKED_UP' ? 'bg-blue-100 text-blue-700' :
                            'bg-gray-100 text-gray-700'}`}
                        >
                          {del.status.replace('_', ' ')}
                        </span>
                      </div>
                      <p className="text-xs text-gray-600 flex items-center gap-1.5">
                        <MapPin size={12} className="text-gray-400" />
                        {del.order.customerName}
                      </p>
                      <p className="text-xs text-gray-500 ml-4 mt-1">{Number(del.order.quantity)} {del.order.unit} {del.order.product}</p>
                    </div>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
