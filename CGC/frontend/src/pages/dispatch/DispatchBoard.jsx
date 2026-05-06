import React, { useState, useEffect } from 'react';
import api from '../../api/axios';
import { Truck, MapPin, Search, ChevronUp, ChevronDown, Flag, User, GripVertical, Mail, Package2, Image as ImageIcon, Calendar } from 'lucide-react';
import { motion, Reorder, AnimatePresence } from 'framer-motion';
import { toast } from 'react-hot-toast';
import { DispatchBoardSkeleton } from '../../components/Skeleton';
import { FadeInUp, StaggerContainer, StaggerItem } from '../../components/Animated';
import Modal from '../../components/Modal';
import StatusBadge from '../../components/deliveries/StatusBadge';
import StatusTimeline from '../../components/deliveries/StatusTimeline';

export default function DispatchBoard() {
  const [board, setBoard] = useState({ unassignedOrders: [], unassignedDeliveries: [], drivers: [] });
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('unassigned');
  const [expandedDriverId, setExpandedDriverId] = useState(null);
  const [expandedDeliveryId, setExpandedDeliveryId] = useState(null);
  
  const [confirmModal, setConfirmModal] = useState({ isOpen: false, order: null, driver: null });

  const fetchBoard = async () => {
    try {
      setLoading(true);
      const res = await api.get('/api/dispatch');
      const drivers = res.data.drivers.map(d => ({
        ...d,
        deliveries: [...(d.deliveries || [])].sort((a, b) => (a.priority || 0) - (b.priority || 0))
      }));
      setBoard({ ...res.data, drivers });
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBoard();
  }, []);

  const handleAssign = async () => {
    const { order, driver } = confirmModal;
    try {
      await api.post('/api/dispatch/assign', { orderId: order.id, driverId: driver.id });
      toast.success(`Assigned ${order.spruceOrderId} to ${driver.name}`);
      setConfirmModal({ isOpen: false, order: null, driver: null });
      fetchBoard();
    } catch (e) {
      console.error('Assign failed', e);
      toast.error('Assignment failed');
    }
  };

  const handleResendEmail = async (deliveryId) => {
    try {
      const res = await api.post(`/api/dispatch/resend-email/${deliveryId}`);
      if (res.data.success) {
        toast.success('Email resent successfully');
      } else {
        toast.error(`Failed to send: ${res.data.error || 'Check credentials'}`);
      }
    } catch (e) {
      toast.error('Failed to resend email');
    }
  };

  const openConfirm = (order, driverId) => {
    const driver = board.drivers.find(d => d.id === driverId);
    setConfirmModal({ isOpen: true, order, driver });
  };

  const handleReorder = async (driverId, newDeliveries) => {
    // Optimistic update
    const updatedDrivers = board.drivers.map(d => {
      if (d.id === driverId) {
        return { ...d, deliveries: newDeliveries };
      }
      return d;
    });
    setBoard({ ...board, drivers: updatedDrivers });

    try {
      const deliveryIds = newDeliveries.map(d => d.id);
      await api.post('/api/dispatch/reorder', { driverId, deliveryIds });
    } catch (e) {
      console.error('Reorder failed', e);
      toast.error('Failed to save priority');
    }
  };

  const handleStatusUpdate = async (deliveryId, newStatus) => {
    try {
      await api.patch(`/api/deliveries/${deliveryId}/status`, { status: newStatus });
      toast.success(`Status updated to ${newStatus}`);
      fetchBoard();
    } catch (e) {
      console.error(e);
      toast.error('Failed to update status');
    }
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <FadeInUp>
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Dispatch Board</h1>
            <p className="text-sm text-gray-500">Manage daily assignments and track driver workflows.</p>
          </div>
          <div className="flex items-center gap-3 bg-white px-4 py-2 rounded-xl border border-gray-200 shadow-sm">
            <Search size={18} className="text-gray-400" />
            <input type="text" placeholder="Search orders, customers..." className="outline-none text-sm w-48" />
          </div>
        </div>
      </FadeInUp>

      <FadeInUp delay={0.1} className="flex gap-6 border-b border-gray-200">
        <button
          className={`pb-3 font-bold text-sm transition-colors relative ${activeTab === 'unassigned' ? 'text-[#2D6A4F]' : 'text-gray-500 hover:text-gray-700'}`}
          onClick={() => setActiveTab('unassigned')}
        >
          Unassigned Orders
          <span className="ml-2 bg-gray-100 px-2 py-0.5 rounded-full text-[10px]">{board.unassignedOrders.length}</span>
          {activeTab === 'unassigned' && <motion.div layoutId="tab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#2D6A4F]" />}
        </button>
        <button
          className={`pb-3 font-bold text-sm transition-colors relative ${activeTab === 'assigned' ? 'text-[#2D6A4F]' : 'text-gray-500 hover:text-gray-700'}`}
          onClick={() => setActiveTab('assigned')}
        >
          Assigned Drivers
          <span className="ml-2 bg-gray-100 px-2 py-0.5 rounded-full text-[10px]">{board.drivers.length}</span>
          {activeTab === 'assigned' && <motion.div layoutId="tab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#2D6A4F]" />}
        </button>
      </FadeInUp>

      {loading && board.drivers.length === 0 ? (
        <DispatchBoardSkeleton activeTab={activeTab} />
      ) : activeTab === 'unassigned' ? (
        <FadeInUp delay={0.2} className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50/50 text-gray-500 border-b">
              <tr>
                <th className="px-6 py-4 font-bold uppercase tracking-wider text-[10px]">Order ID</th>
                <th className="px-6 py-4 font-bold uppercase tracking-wider text-[10px]">Customer</th>
                <th className="px-6 py-4 font-bold uppercase tracking-wider text-[10px]">Details</th>
                <th className="px-6 py-4 font-bold uppercase tracking-wider text-[10px] text-right">Assign Driver</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {board.unassignedOrders.map(order => (
                <tr key={order.id} className="hover:bg-gray-50/50 transition-colors">
                  <td className="px-6 py-4 font-bold text-gray-900">{order.spruceOrderId}</td>
                  <td className="px-6 py-4 text-gray-700 font-medium">{order.customerName}</td>
                  <td className="px-6 py-4 text-gray-500">
                    <span className="bg-blue-50 text-blue-700 px-2 py-0.5 rounded text-[10px] font-bold mr-2 uppercase">{order.product}</span>
                    {Number(order.quantity)} {order.unit}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <select
                      className="border border-gray-300 rounded-xl px-4 py-2 text-xs font-bold bg-white focus:ring-2 focus:ring-[#2D6A4F] outline-none cursor-pointer"
                      onChange={(e) => {
                        if(e.target.value) openConfirm(order, e.target.value);
                      }}
                      defaultValue=""
                    >
                      <option value="" disabled>Select Driver...</option>
                      {board.drivers.map(d => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
              {board.unassignedOrders.length === 0 && (
                <tr><td colSpan="4" className="px-6 py-12 text-center text-gray-400 italic">No unassigned orders found</td></tr>
              )}
            </tbody>
          </table>
        </FadeInUp>
      ) : (
        <div className="space-y-4">
          {board.drivers.map(driver => {
            const isExpanded = expandedDriverId === driver.id;
            return (
              <div key={driver.id} className={`bg-white rounded-2xl border transition-all duration-300 ${isExpanded ? 'border-[#2D6A4F] shadow-lg ring-1 ring-[#2D6A4F]/10' : 'border-gray-200 shadow-sm hover:border-gray-300'}`}>
                {/* Driver Header */}
                <button 
                  onClick={() => setExpandedDriverId(isExpanded ? null : driver.id)}
                  className="w-full px-6 py-5 flex items-center justify-between text-left group"
                >
                  <div className="flex items-center gap-5">
                    <div className={`w-12 h-12 rounded-2xl flex items-center justify-center font-black text-lg transition-colors ${isExpanded ? 'bg-[#1B4332] text-white' : 'bg-gray-100 text-gray-400 group-hover:bg-gray-200'}`}>
                      {driver.name.split(' ').map(n => n[0]).join('').toUpperCase()}
                    </div>
                    <div>
                      <h3 className="font-bold text-gray-900 text-lg leading-none">{driver.name}</h3>
                      <div className="flex items-center gap-3 mt-2 text-xs font-bold uppercase tracking-tight text-gray-400">
                        <span className="flex items-center gap-1.5"><Truck size={12} /> {driver.type === 'CGC_FLEET' ? 'FLEET' : 'EXTERNAL'}</span>
                        <span>•</span>
                        <span className="flex items-center gap-1.5"><Package2 size={12} /> {driver.deliveries.length} ASSIGNMENTS</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                     <div className="text-right mr-4 hidden sm:block">
                       <p className="text-[10px] font-black text-gray-400 uppercase leading-none mb-1">COMPLETED</p>
                       <p className="text-lg font-black text-gray-900 leading-none">
                         {driver.deliveries.filter(d => d.status === 'DELIVERED').length} / {driver.deliveries.length}
                       </p>
                     </div>
                     <div className={`p-2 rounded-xl transition-colors ${isExpanded ? 'bg-[#2D6A4F]/10 text-[#2D6A4F]' : 'bg-gray-50 text-gray-400'}`}>
                       {isExpanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
                     </div>
                  </div>
                </button>

                {/* Deliveries List */}
                <AnimatePresence>
                  {isExpanded && (
                    <motion.div 
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden border-t border-gray-100"
                    >
                      <div className="p-4 sm:p-6 bg-gray-50/30">
                        {driver.deliveries.length === 0 ? (
                          <div className="py-10 text-center text-gray-400 font-medium italic">No deliveries assigned today</div>
                        ) : (
                          <Reorder.Group 
                            axis="y" 
                            values={driver.deliveries} 
                            onReorder={(newOrder) => handleReorder(driver.id, newOrder)}
                            className="space-y-4"
                          >
                            {driver.deliveries.map((del, idx) => {
                              const isDelExpanded = expandedDeliveryId === del.id;
                              return (
                                <Reorder.Item 
                                  value={del} 
                                  key={del.id}
                                  className={`bg-white rounded-xl border transition-all duration-300 ${isDelExpanded ? 'border-amber-200 shadow-md ring-1 ring-amber-100' : 'border-gray-200 shadow-sm hover:border-gray-300'}`}
                                >
                                  {/* Delivery Header */}
                                  <div className="px-5 py-4 flex items-center justify-between gap-4">
                                    <div className="flex items-center gap-4 flex-1">
                                      <div className="cursor-grab active:cursor-grabbing p-1 text-gray-300 hover:text-gray-500 transition-colors">
                                        <GripVertical size={20} />
                                      </div>
                                      <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-[10px] font-black text-gray-500">
                                        {idx + 1}
                                      </div>
                                      <div>
                                        <h4 className="font-bold text-gray-900 leading-none">{del.order.spruceOrderId}</h4>
                                        <p className="text-[10px] text-gray-500 mt-1 font-bold uppercase truncate max-w-[200px]">{del.order.customerName}</p>
                                      </div>
                                    </div>

                                    <div className="hidden md:block flex-1">
                                       <p className="text-[10px] font-black text-gray-400 uppercase leading-none mb-1">PRIORITY</p>
                                       <div className="flex items-center gap-1.5 text-gray-900 font-bold text-sm">
                                         <Flag size={14} className={idx === 0 ? "text-orange-500" : "text-gray-300"} />
                                         {idx === 0 ? 'Urgent' : `Standard (${idx + 1})`}
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
                                          onClick={(e) => { e.stopPropagation(); handleResendEmail(del.id); }}
                                          className="p-1.5 rounded-lg hover:bg-gray-100 text-[#2D6A4F] transition-colors"
                                          title="Resend Link Email"
                                        >
                                          <Mail size={16} />
                                        </button>
                                        <button 
                                          onClick={() => setExpandedDeliveryId(isDelExpanded ? null : del.id)}
                                          className={`p-1.5 rounded-lg transition-colors ${isDelExpanded ? 'bg-amber-100 text-amber-600' : 'hover:bg-gray-100 text-gray-400'}`}
                                        >
                                          {isDelExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
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
                                        <div className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-8 bg-gray-50/50">
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
                                              <div className="flex items-center gap-4 text-[10px] font-black text-gray-500">
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
                                </Reorder.Item>
                              );
                            })}
                          </Reorder.Group>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      )}
      <Modal 
        isOpen={confirmModal.isOpen} 
        onClose={() => setConfirmModal({ isOpen: false, order: null, driver: null })}
        title="Confirm Assignment"
      >
        <div className="space-y-6">
          <div className="bg-gray-50 rounded-2xl p-6 border border-gray-100">
            <p className="text-sm text-gray-500 font-bold uppercase tracking-widest mb-4">You are assigning</p>
            <div className="flex justify-between items-start">
              <div>
                <h4 className="text-xl font-black text-gray-900 leading-none">{confirmModal.order?.spruceOrderId}</h4>
                <p className="text-sm text-gray-500 mt-2 font-bold uppercase truncate max-w-[300px]">{confirmModal.order?.customerName}</p>
              </div>
              <div className="text-right">
                <p className="text-lg font-black text-[#2D6A4F] leading-none">{Number(confirmModal.order?.quantity)} {confirmModal.order?.unit}</p>
                <p className="text-[10px] text-gray-400 mt-1 font-bold uppercase">{confirmModal.order?.product}</p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-4 px-2">
            <div className="w-12 h-12 rounded-2xl bg-[#1B4332] text-white flex items-center justify-center font-black text-lg shadow-sm">
              {confirmModal.driver?.name?.split(' ').map(n => n[0]).join('').toUpperCase()}
            </div>
            <div>
              <p className="text-xs text-gray-400 font-black uppercase leading-none mb-1">To Driver</p>
              <h3 className="font-bold text-gray-900 text-lg leading-tight">{confirmModal.driver?.name}</h3>
            </div>
          </div>

          <div className="flex gap-3 pt-4 border-t border-gray-100">
            <button 
              onClick={() => setConfirmModal({ isOpen: false, order: null, driver: null })}
              className="flex-1 px-6 py-3 rounded-xl border border-gray-200 font-black text-sm text-gray-500 hover:bg-gray-50 transition-colors"
            >
              CANCEL
            </button>
            <button 
              onClick={handleAssign}
              className="flex-1 px-6 py-3 rounded-xl bg-[#2D6A4F] text-white font-black text-sm hover:bg-[#1B4332] transition-all shadow-lg shadow-[#2D6A4F]/20"
            >
              CONFIRM ASSIGNMENT
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}