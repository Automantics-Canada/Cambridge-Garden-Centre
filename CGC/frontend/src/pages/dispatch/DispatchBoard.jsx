import React, { useState, useEffect } from 'react';
import api from '../../api/axios';
import { Truck, MapPin, Search, ChevronUp, ChevronDown, Flag, User, GripVertical } from 'lucide-react';
import { motion, Reorder } from 'framer-motion';
import { toast } from 'react-hot-toast';
import { DispatchBoardSkeleton } from '../../components/Skeleton';
import { FadeInUp, StaggerContainer, StaggerItem } from '../../components/Animated';
import Modal from '../../components/Modal';

export default function DispatchBoard() {
  const [board, setBoard] = useState({ unassignedOrders: [], unassignedDeliveries: [], drivers: [] });
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('unassigned');
  
  // Confirmation Modal State
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
      await api.patch('/api/dispatch/reorder', { driverId, deliveryIds });
      // No need to fetchBoard here as we did optimistic update, 
      // but maybe priority values in state need updating? 
      // The backend re-assigns priorities 1, 2, 3...
    } catch (e) {
      console.error('Reorder failed', e);
      toast.error('Failed to save priority');
      fetchBoard(); // Revert on failure
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
        <div className="space-y-10">
          {board.drivers.map(driver => (
            <div key={driver.id} className="space-y-4">
              <div className="flex items-center gap-4 px-2">
                <div className="w-10 h-10 rounded-full bg-[#1B4332] text-white flex items-center justify-center font-bold text-sm shadow-sm">
                  {driver.name.split(' ').map(n => n[0]).join('').toUpperCase()}
                </div>
                <div>
                  <h3 className="font-bold text-gray-900 text-lg leading-tight">{driver.name}</h3>
                  <p className="text-xs text-gray-500 font-medium">
                    {driver.type === 'CGC_FLEET' ? 'Fleet' : 'Independent'} • ${driver.ratePerTrip}/delivery • {driver.deliveries.length} orders
                  </p>
                </div>
              </div>

              <Reorder.Group 
                axis="y" 
                values={driver.deliveries} 
                onReorder={(newOrder) => handleReorder(driver.id, newOrder)}
                className="space-y-3"
              >
                {driver.deliveries.length === 0 ? (
                  <div className="p-8 text-center border-2 border-dashed border-gray-200 rounded-2xl text-gray-400 text-sm font-medium">
                    Drag and drop orders here to assign
                  </div>
                ) : (
                  driver.deliveries.map((del, idx) => (
                    <Reorder.Item 
                      key={del.id} 
                      value={del}
                      className="bg-white border border-gray-200 rounded-2xl shadow-sm p-4 cursor-grab active:cursor-grabbing hover:border-[#2D6A4F]/30 transition-colors"
                    >
                      <div className="flex items-center gap-5">
                        <div className="flex items-center gap-3">
                          <GripVertical className="text-gray-300" size={18} />
                          <div className="w-6 h-6 rounded-full bg-gray-100 flex items-center justify-center text-[10px] font-black text-gray-500">
                            {idx + 1}
                          </div>
                        </div>

                        <div className="flex-shrink-0">
                          <Flag size={18} className={idx === 0 ? "text-orange-500" : "text-gray-300"} />
                        </div>

                        <div className="flex-1 grid grid-cols-4 gap-4 items-center">
                          <div className="col-span-1">
                            <p className="text-sm font-bold text-gray-900">{del.order.spruceOrderId}</p>
                            <p className="text-[10px] font-bold text-[#2D6A4F] uppercase tracking-tight">{del.order.buyerType}</p>
                          </div>
                          <div className="col-span-1">
                            <p className="text-sm font-bold text-gray-900 truncate">{del.order.customerName}</p>
                            <p className="text-[10px] text-gray-500 truncate">78 Hespeler Rd, Cambridge, ON</p>
                          </div>
                          <div className="col-span-1">
                            <p className="text-xs font-medium text-gray-700 truncate">{del.order.product}</p>
                            <p className="text-[10px] text-gray-500">{Number(del.order.quantity)} {del.order.unit}</p>
                          </div>
                          <div className="col-span-1 flex justify-center">
                            <span className={`text-[10px] font-black px-3 py-1 rounded-full uppercase tracking-tighter border
                              ${del.status === 'DELIVERED' ? 'bg-green-50 text-green-700 border-green-100' :
                                del.status === 'IN_TRANSIT' ? 'bg-amber-50 text-amber-700 border-amber-100' :
                                del.status === 'PICKED_UP' ? 'bg-blue-50 text-blue-700 border-blue-100' :
                                'bg-gray-50 text-gray-500 border-gray-100'}`}
                            >
                              {del.status.replace('_', ' ')}
                            </span>
                          </div>
                        </div>

                        <div className="flex flex-col gap-1">
                          <button className="p-1 hover:bg-gray-100 rounded text-gray-400 hover:text-gray-900 transition-colors">
                            <ChevronUp size={16} />
                          </button>
                          <button className="p-1 hover:bg-gray-100 rounded text-gray-400 hover:text-gray-900 transition-colors">
                            <ChevronDown size={16} />
                          </button>
                        </div>
                      </div>
                    </Reorder.Item>
                  ))
                )}
              </Reorder.Group>
            </div>
          ))}
        </div>
      )}
      {/* Assignment Confirmation Modal */}
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
