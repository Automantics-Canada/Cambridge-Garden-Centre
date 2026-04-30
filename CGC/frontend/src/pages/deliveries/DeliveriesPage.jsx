import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api/axios';
import { Truck, Search, MapPin, ExternalLink, Calendar, ChevronDown, ChevronUp } from 'lucide-react';

export default function DeliveriesPage() {
  const [searchParams] = useSearchParams();
  const [deliveries, setDeliveries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(null);

  const driverId = searchParams.get('driverId');

  useEffect(() => {
    const fetchDeliveries = async () => {
      try {
        setLoading(true);
        let url = '/api/deliveries';
        if (driverId) url += `?driverId=${driverId}`;
        const res = await api.get(url);
        setDeliveries(res.data);
      } catch (e) {
        console.error('Failed to fetch deliveries', e);
      } finally {
        setLoading(false);
      }
    };
    fetchDeliveries();
  }, [driverId]);

  const toggleExpand = (id) => {
    setExpandedId(expandedId === id ? null : id);
  };

  const statusColors = {
    UNASSIGNED: 'bg-gray-100 text-gray-700 border-gray-200',
    ASSIGNED: 'bg-gray-100 text-gray-800 border-gray-300',
    PICKED_UP: 'bg-blue-50 text-blue-700 border-blue-200',
    IN_TRANSIT: 'bg-amber-50 text-amber-700 border-amber-200',
    DELIVERED: 'bg-green-50 text-green-700 border-green-200'
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Deliveries Log</h1>
        <p className="text-sm text-gray-500">Track and review all dispatch activities and photos.</p>
      </div>

      {loading ? (
         <div className="flex justify-center p-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#2D6A4F]"></div></div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 text-gray-500 border-b border-gray-200">
              <tr>
                <th className="px-6 py-4 font-semibold">Order</th>
                <th className="px-6 py-4 font-semibold">Driver</th>
                <th className="px-6 py-4 font-semibold">Status</th>
                <th className="px-6 py-4 font-semibold">Time</th>
                <th className="px-6 py-4 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {deliveries.map(del => (
                <React.Fragment key={del.id}>
                  <tr className={`hover:bg-gray-50/50 transition-colors cursor-pointer ${expandedId === del.id ? 'bg-gray-50' : ''}`} onClick={() => toggleExpand(del.id)}>
                    <td className="px-6 py-4">
                      <div className="font-bold text-gray-900">{del.order.spruceOrderId}</div>
                      <div className="text-xs text-gray-500">{del.order.customerName}</div>
                    </td>
                    <td className="px-6 py-4">
                      {del.driver ? (
                         <div>
                           <div className="font-semibold text-gray-800">{del.driver.name}</div>
                           <div className="text-xs text-gray-500">{del.driver.type === 'CGC_FLEET' ? 'Fleet' : 'Independent'}</div>
                         </div>
                      ) : <span className="text-gray-400 italic">Unassigned</span>}
                    </td>
                    <td className="px-6 py-4">
                       <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border ${statusColors[del.status]}`}>
                         {del.status.replace('_', ' ')}
                       </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-xs text-gray-600">
                        {del.startedAt ? new Date(del.startedAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '--'} 
                        {' → '} 
                        {del.completedAt ? new Date(del.completedAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '--'}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-right">
                       <button className="p-2 text-gray-400 hover:text-[#2D6A4F] rounded-lg hover:bg-green-50 transition-colors">
                         {expandedId === del.id ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                       </button>
                    </td>
                  </tr>
                  
                  {expandedId === del.id && (
                    <tr>
                      <td colSpan="5" className="px-0 py-0 border-b border-gray-200">
                        <div className="bg-gray-50 p-6 border-l-4 border-[#2D6A4F] animate-in slide-in-from-top-2 duration-200">
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                            
                            {/* Details Pane */}
                            <div className="space-y-4">
                              <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wider">Delivery Details</h4>
                              <div>
                                <p className="font-semibold text-gray-900 text-sm">{del.order.customerName}</p>
                                <p className="text-sm text-gray-600 mt-1">{Number(del.order.quantity)} {del.order.unit} {del.order.product}</p>
                                {del.order.supplier && (
                                  <p className="text-xs text-gray-500 mt-2">Supplier: {del.order.supplier.name}</p>
                                )}
                              </div>
                            </div>

                            {/* Driver Pane */}
                            <div className="space-y-4">
                              <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wider">Driver Details</h4>
                              {del.driver ? (
                                <div>
                                  <p className="font-semibold text-gray-900 text-sm flex items-center gap-2">
                                    <Truck size={14} className="text-[#2D6A4F]"/>
                                    {del.driver.name}
                                  </p>
                                  <p className="text-sm text-gray-600 mt-1">{del.driver.phone}</p>
                                  <p className="text-xs text-gray-500 mt-2">Rate: ${del.driver.ratePerTrip}/trip</p>
                                </div>
                              ) : <p className="text-sm text-gray-500 italic">No driver assigned</p>}
                            </div>

                            {/* Photos Pane */}
                            <div className="space-y-4">
                              <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wider">Evidence Photos</h4>
                              <div className="flex gap-4">
                                <div className="flex-1">
                                  <p className="text-[10px] font-bold text-gray-500 mb-1">PICKUP {del.pickupType === 'EXTERNAL' && '(REQ)'}</p>
                                  {del.pickupPhotoUrl ? (
                                    <a href={del.pickupPhotoUrl} target="_blank" rel="noopener noreferrer">
                                      <img src={del.pickupPhotoUrl} alt="Pickup" className="w-full h-24 object-cover rounded-lg border border-gray-200 hover:opacity-80 transition-opacity" />
                                    </a>
                                  ) : (
                                    <div className="w-full h-24 bg-gray-100 rounded-lg border border-dashed border-gray-300 flex items-center justify-center text-xs text-gray-400">
                                      Missing
                                    </div>
                                  )}
                                </div>
                                <div className="flex-1">
                                  <p className="text-[10px] font-bold text-gray-500 mb-1">DELIVERY</p>
                                  {del.deliveryPhotoUrl ? (
                                    <a href={del.deliveryPhotoUrl} target="_blank" rel="noopener noreferrer">
                                      <img src={del.deliveryPhotoUrl} alt="Delivery" className="w-full h-24 object-cover rounded-lg border border-gray-200 hover:opacity-80 transition-opacity" />
                                    </a>
                                  ) : (
                                    <div className="w-full h-24 bg-gray-100 rounded-lg border border-dashed border-gray-300 flex items-center justify-center text-xs text-gray-400">
                                      Missing
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
              {deliveries.length === 0 && (
                <tr><td colSpan="5" className="px-6 py-12 text-center text-gray-500">No deliveries found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
