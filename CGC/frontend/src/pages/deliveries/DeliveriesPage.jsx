import React, { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api/axios';
import { Truck, Search, MapPin, ExternalLink, Calendar, ChevronDown, ChevronUp, User, Clock, Image as ImageIcon, History, MoreVertical, Flag, Package2, GripVertical } from 'lucide-react';
import { DeliveryTableSkeleton } from '../../components/Skeleton';
import { FadeInUp, StaggerContainer, StaggerItem } from '../../components/Animated';
import { Reorder, motion, AnimatePresence } from 'framer-motion';
import { toast } from 'react-hot-toast';
import StatusBadge from '../../components/deliveries/StatusBadge';
import StatusTimeline from '../../components/deliveries/StatusTimeline';

export default function DeliveriesPage() {
  const [searchParams] = useSearchParams();
  const [deliveries, setDeliveries] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedDriverId, setExpandedDriverId] = useState(null);
  const [expandedDeliveryId, setExpandedDeliveryId] = useState(null);

  const driverIdParam = searchParams.get('driverId');

  const fetchData = async () => {
    try {
      setLoading(true);
      const [delRes, driverRes] = await Promise.all([
        api.get('/api/deliveries'),
        api.get('/api/drivers')
      ]);
      setDeliveries(delRes.data);
      setDrivers(driverRes.data);
      
      if (driverIdParam) {
        setExpandedDriverId(driverIdParam);
      }
    } catch (e) {
      console.error('Failed to fetch data', e);
      toast.error('Failed to load deliveries');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleStatusUpdate = async (deliveryId, newStatus) => {
    try {
      await api.patch(`/api/deliveries/${deliveryId}/status`, { status: newStatus });
      toast.success(`Status updated to ${newStatus}`);
      fetchData();
    } catch (e) {
      console.error(e);
      toast.error('Failed to update status');
    }
  };

  const handleReorder = async (driverId, newDeliveries) => {
    // We need to re-assign priorities based on the new order for this specific driver's deliveries
    const otherDeliveries = deliveries.filter(d => d.driverId !== driverId);
    const sortedForDriver = newDeliveries.map((d, index) => ({ ...d, priority: index + 1 }));
    
    setDeliveries([...otherDeliveries, ...sortedForDriver]);

    try {
      await api.post('/api/dispatch/reorder', {
        driverId,
        deliveryIds: newDeliveries.map(d => d.id)
      });
      toast.success('Priority updated');
    } catch (e) {
      console.error(e);
      toast.error('Failed to update priority');
      fetchData(); // Rollback
    }
  };

  const groupedDeliveries = useMemo(() => {
    const map = {};
    deliveries.forEach(del => {
      const dId = del.driverId || 'unassigned';
      if (!map[dId]) map[dId] = [];
      map[dId].push(del);
    });
    return map;
  }, [deliveries]);

  if (loading) return <DeliveryTableSkeleton />;

  return (
    <div className="space-y-6 max-w-6xl mx-auto pb-20">
      <FadeInUp>
        <div className="flex justify-between items-end">
          <div>
            <h1 className="text-2xl font-black text-gray-900 tracking-tight">Delivery Logs</h1>
            <p className="text-sm text-gray-500 mt-1 font-medium">History and logs of all system deliveries.</p>
          </div>
        </div>
      </FadeInUp>

      <div className="space-y-4">
        {deliveries.length === 0 ? (
          <div className="py-20 text-center bg-white rounded-2xl border border-dashed border-gray-200 text-gray-400 font-medium">
            No deliveries found in the logs
          </div>
        ) : (
          deliveries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map((del, idx) => {
            const isDelExpanded = expandedDeliveryId === del.id;
            return (
              <div 
                key={del.id}
                className={`bg-white rounded-2xl border transition-all duration-300 ${isDelExpanded ? 'border-amber-200 shadow-lg ring-1 ring-amber-100' : 'border-gray-200 shadow-sm hover:border-gray-300'}`}
              >
                {/* Delivery Header */}
                <div className="px-6 py-5 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-5 flex-1">
                    <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center text-xs font-black text-gray-500">
                      {idx + 1}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="font-bold text-gray-900 text-lg leading-none">{del.order.spruceOrderId}</h4>
                        <span className={`text-[10px] font-black px-2 py-0.5 rounded bg-gray-100 text-gray-500 border border-gray-200`}>
                          {del.order.product}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-2">
                        <p className="text-xs text-gray-500 font-bold uppercase truncate max-w-[200px]">{del.order.customerName}</p>
                        <span className="text-gray-300">•</span>
                        <span className="text-xs text-[#2D6A4F] font-black uppercase flex items-center gap-1">
                          <User size={12} /> {del.driver?.name || 'UNASSIGNED'}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="hidden md:block flex-1">
                    <p className="text-[10px] font-black text-gray-400 uppercase leading-none mb-1">SCHEDULED</p>
                    <div className="flex items-center gap-1.5 text-gray-900 font-bold text-sm">
                      <Calendar size={14} className="text-gray-400" />
                      {new Date(del.createdAt).toLocaleDateString()}
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <StatusBadge status={del.status} />
                    <div className="flex items-center gap-2">
                      <select 
                        className="text-[10px] font-black border border-gray-200 rounded-lg px-2 py-1 outline-none focus:ring-1 focus:ring-[#2D6A4F] bg-white cursor-pointer"
                        value={del.status}
                        onChange={(e) => handleStatusUpdate(del.id, e.target.value)}
                      >
                        <option value="PLACED">Placed</option>
                        <option value="OUT_FOR_DELIVERY">Out for Delivery</option>
                        <option value="IN_TRANSIT">In Transit</option>
                        <option value="DELIVERED">Delivered</option>
                        <option value="ON_HOLD">On Hold</option>
                        <option value="DELAYED">Delayed</option>
                        <option value="CANCELLED">Cancelled</option>
                      </select>
                      <button 
                        onClick={() => setExpandedDeliveryId(isDelExpanded ? null : del.id)}
                        className={`p-2 rounded-xl transition-colors ${isDelExpanded ? 'bg-amber-100 text-amber-600' : 'bg-gray-50 text-gray-400 hover:bg-gray-100'}`}
                      >
                        {isDelExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Delivery Details */}
                <AnimatePresence>
                  {isDelExpanded && (
                    <motion.div 
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden border-t border-gray-50"
                    >
                      <div className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-8 bg-gray-50/30">
                        {/* Column 1: Order & Customer */}
                        <div className="space-y-6">
                          <div>
                            <label className="text-[10px] font-black text-gray-400 uppercase tracking-wider mb-2 block">Order Info</label>
                            <div className="bg-white border border-gray-100 rounded-xl p-4 space-y-3">
                              <div className="flex items-center justify-between">
                                 <span className="text-xs text-gray-500 font-bold uppercase">Customer</span>
                                 <span className="text-xs text-gray-900 font-black">{del.order.customerName}</span>
                              </div>
                              <div className="flex items-center justify-between">
                                 <span className="text-xs text-gray-500 font-bold uppercase">Material</span>
                                 <span className="text-xs text-gray-900 font-black">{del.order.product}</span>
                              </div>
                              <div className="flex items-center justify-between">
                                 <span className="text-xs text-gray-500 font-bold uppercase">Quantity</span>
                                 <span className="text-xs text-gray-900 font-black">{Number(del.order.quantity)} {del.order.unit}</span>
                              </div>
                            </div>
                          </div>
                          <div>
                            <label className="text-[10px] font-black text-gray-400 uppercase tracking-wider mb-2 block">Timeline Summary</label>
                            <div className="flex items-center gap-6 text-[10px] font-black text-gray-500">
                               <div className="flex flex-col">
                                 <span className="text-gray-400 uppercase">Started</span>
                                 <span className="text-gray-900">{del.startedAt ? new Date(del.startedAt).toLocaleTimeString() : '--:--'}</span>
                               </div>
                               <div className="flex flex-col">
                                 <span className="text-gray-400 uppercase">Completed</span>
                                 <span className="text-gray-900">{del.completedAt ? new Date(del.completedAt).toLocaleTimeString() : '--:--'}</span>
                               </div>
                            </div>
                          </div>
                        </div>

                        {/* Column 2: Evidence Photos */}
                        <div className="space-y-4">
                          <label className="text-[10px] font-black text-gray-400 uppercase tracking-wider mb-2 block">Evidence Photos</label>
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <p className="text-[9px] font-black text-gray-400 uppercase mb-1">Pickup</p>
                              {del.pickupPhotoUrl ? (
                                <img src={del.pickupPhotoUrl} className="w-full h-32 object-cover rounded-xl border border-gray-200" alt="Pickup" />
                              ) : (
                                <div className="w-full h-32 bg-white border border-dashed border-gray-200 rounded-xl flex flex-col items-center justify-center text-gray-300">
                                  <ImageIcon size={20} />
                                  <span className="text-[10px] font-black mt-1">NO PHOTO</span>
                                </div>
                              )}
                            </div>
                            <div>
                              <p className="text-[9px] font-black text-gray-400 uppercase mb-1">Delivery</p>
                              {del.deliveryPhotoUrl ? (
                                <img src={del.deliveryPhotoUrl} className="w-full h-32 object-cover rounded-xl border border-gray-200" alt="Delivery" />
                              ) : (
                                <div className="w-full h-32 bg-white border border-dashed border-gray-200 rounded-xl flex flex-col items-center justify-center text-gray-300">
                                  <ImageIcon size={20} />
                                  <span className="text-[10px] font-black mt-1">NO PHOTO</span>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Column 3: Status History */}
                        <div className="space-y-4">
                          <label className="text-[10px] font-black text-gray-400 uppercase tracking-wider mb-2 block">Update History</label>
                          <div className="max-h-[200px] overflow-y-auto pr-2 custom-scrollbar bg-white rounded-xl border border-gray-100 p-4">
                            <StatusTimeline history={del.history} />
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
