import React, { useState, useEffect } from 'react';
import api from '../../api/axios';
import { Truck, MapPin, Search, ChevronUp, ChevronDown, Flag, User, GripVertical, Mail, Package2, Image as ImageIcon, Calendar, Info, RefreshCw } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'react-hot-toast';
import { DispatchBoardSkeleton } from '../../components/Skeleton';
import { FadeInUp, StaggerContainer, StaggerItem } from '../../components/Animated';
import Modal from '../../components/Modal';
import StatusBadge from '../../components/deliveries/StatusBadge';
import StatusTimeline from '../../components/deliveries/StatusTimeline';

export default function DispatchBoard() {
  const [board, setBoard] = useState({ unassignedOrders: [], unassignedDeliveries: [], drivers: [] });
  const [loading, setLoading] = useState(true);
  const [expandedDriverId, setExpandedDriverId] = useState(null);
  const [expandedDeliveryId, setExpandedDeliveryId] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  
  // Drag states
  const [draggingOrderId, setDraggingOrderId] = useState(null);
  const [draggingFromDriverId, setDraggingFromDriverId] = useState(null);
  const [activeDragTargetDriverId, setActiveDragTargetDriverId] = useState(null);
  const [isOverUnassignedDropZone, setIsOverUnassignedDropZone] = useState(false);

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
      toast.error('Failed to fetch dispatch board');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBoard();
  }, []);

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

  // Drag and Drop Logic
  const handleDragStart = (e, orderId, fromDriverId = null) => {
    setDraggingOrderId(orderId);
    setDraggingFromDriverId(fromDriverId);
    e.dataTransfer.setData('text/plain', orderId);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragEnd = () => {
    setDraggingOrderId(null);
    setDraggingFromDriverId(null);
    setActiveDragTargetDriverId(null);
    setIsOverUnassignedDropZone(false);
  };

  const handleDragOverDriver = (e, driverId) => {
    e.preventDefault();
    if (draggingFromDriverId !== driverId) {
      setActiveDragTargetDriverId(driverId);
    }
  };

  const handleDragLeaveDriver = (driverId) => {
    if (activeDragTargetDriverId === driverId) {
      setActiveDragTargetDriverId(null);
    }
  };

  const handleDropOnDriver = async (e, targetDriverId) => {
    e.preventDefault();
    const orderId = draggingOrderId || e.dataTransfer.getData('text/plain');
    if (!orderId) return;

    if (draggingFromDriverId === targetDriverId) {
      handleDragEnd();
      return;
    }

    const orderObj = findOrder(orderId);
    const driverObj = board.drivers.find(d => d.id === targetDriverId);

    if (!orderObj || !driverObj) {
      handleDragEnd();
      return;
    }

    try {
      // Optimistic updates
      setBoard(prev => {
        let updatedUnassigned = [...prev.unassignedOrders];
        let updatedDrivers = prev.drivers.map(d => {
          let updatedDeliveries = [...d.deliveries];
          // Remove from source driver if it was assigned
          if (draggingFromDriverId && d.id === draggingFromDriverId) {
            updatedDeliveries = updatedDeliveries.filter(del => del.order.id !== orderId);
          }
          // Add to target driver optimistically
          if (d.id === targetDriverId) {
            const alreadyAssigned = updatedDeliveries.some(del => del.order.id === orderId);
            if (!alreadyAssigned) {
              updatedDeliveries.push({
                id: `temp-${Date.now()}`,
                orderId,
                driverId: targetDriverId,
                status: 'PLACED',
                priority: updatedDeliveries.length + 1,
                order: orderObj,
                history: []
              });
            }
          }
          return {
            ...d,
            deliveries: updatedDeliveries,
            todayDeliveries: updatedDeliveries.length
          };
        });

        if (!draggingFromDriverId) {
          updatedUnassigned = updatedUnassigned.filter(o => o.id !== orderId);
        }

        return {
          ...prev,
          unassignedOrders: updatedUnassigned,
          drivers: updatedDrivers
        };
      });

      await api.post('/api/dispatch/assign', { orderId, driverId: targetDriverId });
      toast.success(`Assigned ${orderObj.spruceOrderId} to ${driverObj.name}`);
    } catch (err) {
      console.error(err);
      toast.error('Failed to assign driver');
      fetchBoard();
    } finally {
      handleDragEnd();
    }
  };

  const handleDragOverUnassigned = (e) => {
    e.preventDefault();
    if (draggingFromDriverId) {
      setIsOverUnassignedDropZone(true);
    }
  };

  const handleDragLeaveUnassigned = () => {
    setIsOverUnassignedDropZone(false);
  };

  const handleDropOnUnassigned = async (e) => {
    e.preventDefault();
    const orderId = draggingOrderId || e.dataTransfer.getData('text/plain');
    if (!orderId || !draggingFromDriverId) {
      handleDragEnd();
      return;
    }

    const orderObj = findOrder(orderId);
    if (!orderObj) {
      handleDragEnd();
      return;
    }

    try {
      // Optimistic updates
      setBoard(prev => {
        let updatedDrivers = prev.drivers.map(d => {
          let updatedDeliveries = [...d.deliveries];
          if (d.id === draggingFromDriverId) {
            updatedDeliveries = updatedDeliveries.filter(del => del.order.id !== orderId);
          }
          return {
            ...d,
            deliveries: updatedDeliveries,
            todayDeliveries: updatedDeliveries.length
          };
        });

        const alreadyInUnassigned = prev.unassignedOrders.some(o => o.id === orderId);
        const updatedUnassigned = alreadyInUnassigned 
          ? prev.unassignedOrders 
          : [orderObj, ...prev.unassignedOrders];

        return {
          ...prev,
          unassignedOrders: updatedUnassigned,
          drivers: updatedDrivers
        };
      });

      await api.post('/api/dispatch/unassign', { orderId });
      toast.success(`Unassigned order ${orderObj.spruceOrderId}`);
    } catch (err) {
      console.error(err);
      toast.error('Failed to unassign order');
      fetchBoard();
    } finally {
      handleDragEnd();
    }
  };

  const findOrder = (orderId) => {
    const fromUnassigned = board.unassignedOrders.find(o => o.id === orderId);
    if (fromUnassigned) return fromUnassigned;
    
    for (const d of board.drivers) {
      const del = d.deliveries.find(del => del.order.id === orderId);
      if (del) return del.order;
    }
    return null;
  };

  // Filtering based on Search Query
  const filterOrders = (ordersList) => {
    if (!searchQuery) return ordersList;
    const query = searchQuery.toLowerCase();
    return ordersList.filter(o => 
      o.spruceOrderId.toLowerCase().includes(query) ||
      o.customerName.toLowerCase().includes(query) ||
      o.product.toLowerCase().includes(query)
    );
  };

  // Compile all assigned orders to display them in the top section
  const assignedOrders = [];
  board.drivers.forEach(d => {
    d.deliveries.forEach(del => {
      assignedOrders.push({
        ...del.order,
        driver: { id: d.id, name: d.name, type: d.type },
        deliveryId: del.id,
        deliveryStatus: del.status
      });
    });
  });

  const filteredAssignedOrders = filterOrders(assignedOrders);
  const filteredUnassignedOrders = filterOrders(board.unassignedOrders);

  return (
    <div className="space-y-6 max-w-[1600px] mx-auto pb-12">
      {/* Header Panel */}
      <FadeInUp>
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white p-6 rounded-2xl border border-gray-200/80 shadow-sm">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 tracking-tight flex items-center gap-2">
              <Truck className="text-[#2D6A4F]" size={28} />
              Dispatch Board
            </h1>
            <p className="text-sm text-gray-500 mt-1">Manage daily assignments and track driver workflows with real-time drag & drop.</p>
          </div>
          <div className="flex items-center gap-3 w-full md:w-auto">
            <div className="flex items-center gap-3 bg-gray-50 px-4 py-2.5 rounded-xl border border-gray-200 shadow-inner flex-1 md:flex-initial">
              <Search size={18} className="text-gray-400" />
              <input 
                type="text" 
                placeholder="Search orders, customers..." 
                className="bg-transparent outline-none text-sm w-full md:w-64 text-gray-700" 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <button 
              onClick={fetchBoard}
              className="p-2.5 rounded-xl border border-gray-200 text-gray-500 hover:text-gray-900 hover:bg-gray-50 transition-all shadow-sm"
              title="Refresh Board"
            >
              <RefreshCw size={18} className={loading ? "animate-spin" : ""} />
            </button>
          </div>
        </div>
      </FadeInUp>

      {loading && board.drivers.length === 0 ? (
        <DispatchBoardSkeleton activeTab="unassigned" />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          
          {/* LEFT 8 COLUMNS: UNIFIED ORDERS STREAM (ASSIGNED & UNASSIGNED) */}
          <div className="lg:col-span-8 space-y-6">
            
            {/* 1. ASSIGNED ORDERS SECTION */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="bg-gray-50/60 px-6 py-4 border-b border-gray-200/80 flex justify-between items-center">
                <div>
                  <h3 className="font-bold text-gray-900 text-base flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
                    Assigned Orders
                    <span className="bg-emerald-50 text-[#2D6A4F] text-xs font-black px-2 py-0.5 rounded-full ml-1 border border-emerald-100">
                      {filteredAssignedOrders.length} Today
                    </span>
                  </h3>
                  <p className="text-xs text-gray-500 mt-0.5">Drag orders to reassign drivers or pull down to unassign.</p>
                </div>
                <div className="text-xs font-bold text-gray-400 uppercase tracking-wider hidden sm:block">
                  At most 10-12 active assignments
                </div>
              </div>

              <div className="p-6">
                {filteredAssignedOrders.length === 0 ? (
                  <div className="py-16 text-center text-gray-400 border border-dashed border-gray-200 rounded-xl bg-gray-50/30">
                    <Package2 size={40} className="mx-auto text-gray-300 mb-2" />
                    <p className="font-medium text-sm">No assigned orders</p>
                    <p className="text-xs text-gray-400 mt-1">Drag an unassigned order below and drop it onto a driver on the right.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {filteredAssignedOrders.map(order => (
                      <motion.div
                        key={order.id}
                        layoutId={`order-${order.id}`}
                        draggable
                        onDragStart={(e) => handleDragStart(e, order.id, order.driver.id)}
                        onDragEnd={handleDragEnd}
                        className={`bg-white rounded-xl border p-4 shadow-sm hover:shadow-md transition-all cursor-grab active:cursor-grabbing select-none group relative overflow-hidden ${
                          draggingOrderId === order.id ? 'opacity-40 border-[#2D6A4F] border-dashed ring-2 ring-[#2D6A4F]/10' : 'border-gray-200 hover:border-emerald-300'
                        }`}
                      >
                        {/* Drag Handle Accent */}
                        <div className="absolute left-0 top-0 bottom-0 w-1 bg-[#2D6A4F] opacity-70 group-hover:opacity-100 transition-opacity" />

                        <div className="flex justify-between items-start gap-2 pl-2">
                          <div className="space-y-1">
                            <span className="text-xs font-black text-gray-900 tracking-wider flex items-center gap-1.5 uppercase">
                              <GripVertical size={14} className="text-gray-300 group-hover:text-gray-400 transition-colors" />
                              {order.spruceOrderId}
                            </span>
                            <h4 className="font-bold text-gray-800 text-sm leading-tight truncate max-w-[200px]">{order.customerName}</h4>
                          </div>
                          
                          <StatusBadge status={order.deliveryStatus} />
                        </div>

                        <div className="mt-3 pl-2 flex flex-wrap gap-1.5 items-center">
                          <span className="bg-blue-50 text-blue-700 px-2 py-0.5 rounded text-[10px] font-bold uppercase border border-blue-100/50">
                            {order.product}
                          </span>
                          <span className="text-xs text-gray-500 font-medium">
                            {Number(order.quantity)} {order.unit}
                          </span>
                        </div>

                        {/* Driver Assignment Badge */}
                        <div className="mt-4 pt-3 border-t border-gray-100 flex items-center justify-between pl-2">
                          <div className="flex items-center gap-2">
                            <div className="w-6 h-6 rounded-lg bg-emerald-700 text-white flex items-center justify-center font-black text-[10px]">
                              {order.driver.name.split(' ').map(n => n[0]).join('').toUpperCase()}
                            </div>
                            <span className="text-xs font-bold text-gray-700 truncate max-w-[120px]">{order.driver.name}</span>
                          </div>
                          <span className="text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-100 flex items-center gap-1">
                            <Truck size={10} />
                            {order.driver.type === 'CGC_FLEET' ? 'FLEET' : 'EXTERNAL'}
                          </span>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* 2. UNASSIGNED ORDERS STREAM */}
            <div 
              onDragOver={handleDragOverUnassigned}
              onDragLeave={handleDragLeaveUnassigned}
              onDrop={handleDropOnUnassigned}
              className={`bg-white rounded-2xl shadow-sm border overflow-hidden transition-all duration-300 ${
                isOverUnassignedDropZone 
                  ? 'border-[#2D6A4F] ring-4 ring-[#2D6A4F]/10 bg-emerald-50/20' 
                  : 'border-gray-200'
              }`}
            >
              <div className="bg-gray-50/60 px-6 py-4 border-b border-gray-200 flex justify-between items-center">
                <div>
                  <h3 className="font-bold text-gray-900 text-base flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-amber-400"></span>
                    Unassigned Orders
                    <span className="bg-amber-50 text-amber-800 text-xs font-black px-2 py-0.5 rounded-full ml-1 border border-amber-100">
                      {filteredUnassignedOrders.length} Pending
                    </span>
                  </h3>
                  <p className="text-xs text-gray-500 mt-0.5">Drag these orders and drop them on a driver on the right to assign.</p>
                </div>
                {isOverUnassignedDropZone && (
                  <motion.div 
                    initial={{ scale: 0.9 }}
                    animate={{ scale: 1 }}
                    className="text-xs font-extrabold text-[#2D6A4F] bg-[#2D6A4F]/10 px-3 py-1 rounded-lg uppercase tracking-wider animate-bounce"
                  >
                    Drop here to Unassign!
                  </motion.div>
                )}
              </div>

              <div className="p-6">
                {filteredUnassignedOrders.length === 0 ? (
                  <div className="py-16 text-center text-gray-400 border border-dashed border-gray-200 rounded-xl bg-gray-50/30">
                    <Package2 size={40} className="mx-auto text-gray-300 mb-2" />
                    <p className="font-medium text-sm">No unassigned orders</p>
                    <p className="text-xs text-gray-400 mt-1">All orders are fully dispatched!</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {filteredUnassignedOrders.map(order => (
                      <motion.div
                        key={order.id}
                        layoutId={`order-${order.id}`}
                        draggable
                        onDragStart={(e) => handleDragStart(e, order.id, null)}
                        onDragEnd={handleDragEnd}
                        className={`bg-white rounded-xl border p-4 shadow-sm hover:shadow-md transition-all cursor-grab active:cursor-grabbing select-none group relative overflow-hidden ${
                          draggingOrderId === order.id ? 'opacity-40 border-[#2D6A4F] border-dashed ring-2 ring-[#2D6A4F]/10' : 'border-gray-200 hover:border-amber-300'
                        }`}
                      >
                        {/* Drag Handle Accent */}
                        <div className="absolute left-0 top-0 bottom-0 w-1 bg-amber-400 opacity-60 group-hover:opacity-100 transition-opacity" />

                        <div className="flex justify-between items-start gap-2 pl-2">
                          <div className="space-y-1">
                            <span className="text-xs font-black text-gray-900 tracking-wider flex items-center gap-1.5 uppercase">
                              <GripVertical size={14} className="text-gray-300 group-hover:text-gray-400 transition-colors" />
                              {order.spruceOrderId}
                            </span>
                            <h4 className="font-bold text-gray-800 text-sm leading-tight truncate max-w-[200px]">{order.customerName}</h4>
                          </div>
                          
                          <span className="text-[10px] font-extrabold uppercase px-2.5 py-1 rounded bg-amber-50 text-amber-700 border border-amber-100">
                            UNASSIGNED
                          </span>
                        </div>

                        <div className="mt-3 pl-2 flex flex-wrap gap-1.5 items-center">
                          <span className="bg-blue-50 text-blue-700 px-2 py-0.5 rounded text-[10px] font-bold uppercase border border-blue-100/50">
                            {order.product}
                          </span>
                          <span className="text-xs text-gray-500 font-medium">
                            {Number(order.quantity)} {order.unit}
                          </span>
                        </div>

                        <div className="mt-4 pt-3 border-t border-dashed border-gray-100 flex items-center justify-between pl-2">
                          <span className="text-[10px] font-bold text-gray-400 flex items-center gap-1">
                            <Info size={12} className="text-amber-500" />
                            Drag to a driver card
                          </span>
                          
                          {/* Fallback Selector for non-drag devices */}
                          <select
                            className="border border-gray-200 rounded-lg px-2 py-1 text-[10px] font-bold bg-white focus:ring-1 focus:ring-[#2D6A4F] outline-none cursor-pointer text-gray-600 hover:border-gray-300 transition-all"
                            onChange={(e) => {
                              if(e.target.value) {
                                const driverObj = board.drivers.find(d => d.id === e.target.value);
                                if (driverObj) {
                                  // Call assign driver
                                  api.post('/api/dispatch/assign', { orderId: order.id, driverId: driverObj.id })
                                    .then(() => {
                                      toast.success(`Assigned ${order.spruceOrderId} to ${driverObj.name}`);
                                      fetchBoard();
                                    });
                                }
                              }
                            }}
                            value=""
                          >
                            <option value="" disabled>Or Assign...</option>
                            {board.drivers.map(d => (
                              <option key={d.id} value={d.id}>{d.name}</option>
                            ))}
                          </select>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                )}
              </div>
            </div>

          </div>

          {/* RIGHT 4 COLUMNS: ACTIVE DRIVERS (DROP TARGETS) */}
          <div className="lg:col-span-4 space-y-4 lg:sticky lg:top-4 max-h-[85vh] overflow-y-auto pr-1 custom-scrollbar">
            <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-5">
              <h3 className="font-bold text-gray-900 text-base mb-1 flex items-center justify-between">
                <span>Active Drivers</span>
                <span className="bg-gray-100 text-gray-700 text-xs font-black px-2.5 py-0.5 rounded-full">
                  {board.drivers.length}
                </span>
              </h3>
              <p className="text-xs text-gray-500 mb-4">Drop order cards onto any driver below to dispatch instantly.</p>

              <div className="space-y-3">
                {board.drivers.map(driver => {
                  const isExpanded = expandedDriverId === driver.id;
                  const isDragOverTarget = activeDragTargetDriverId === driver.id;
                  
                  return (
                    <div
                      key={driver.id}
                      onDragOver={(e) => handleDragOverDriver(e, driver.id)}
                      onDragLeave={() => handleDragLeaveDriver(driver.id)}
                      onDrop={(e) => handleDropOnDriver(e, driver.id)}
                      className={`bg-white rounded-2xl border transition-all duration-300 relative ${
                        isDragOverTarget 
                          ? 'border-[#2D6A4F] ring-4 ring-[#2D6A4F]/15 bg-emerald-50/20 scale-[1.02] shadow-md' 
                          : isExpanded 
                            ? 'border-[#2D6A4F] shadow-md ring-1 ring-[#2D6A4F]/10' 
                            : 'border-gray-200 hover:border-gray-300 shadow-sm'
                      }`}
                    >
                      {/* Drag overlay message */}
                      {isDragOverTarget && (
                        <div className="absolute inset-0 bg-emerald-600/5 rounded-2xl border-2 border-dashed border-[#2D6A4F] flex items-center justify-center pointer-events-none z-10">
                          <span className="bg-emerald-800 text-white font-extrabold text-xs uppercase tracking-wider px-3 py-1.5 rounded-lg shadow-sm">
                            Drop to Assign!
                          </span>
                        </div>
                      )}

                      {/* Driver Card Header */}
                      <button 
                        onClick={() => setExpandedDriverId(isExpanded ? null : driver.id)}
                        className="w-full px-5 py-4 flex items-center justify-between text-left group"
                      >
                        <div className="flex items-center gap-4 flex-1 overflow-hidden">
                          <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-black text-sm transition-colors flex-shrink-0 ${
                            isExpanded ? 'bg-[#1B4332] text-white' : 'bg-gray-100 text-gray-500 group-hover:bg-gray-200'
                          }`}>
                            {driver.name.split(' ').map(n => n[0]).join('').toUpperCase()}
                          </div>
                          <div className="overflow-hidden">
                            <h3 className="font-bold text-gray-900 text-sm leading-none truncate">{driver.name}</h3>
                            <div className="flex items-center gap-2 mt-2 text-[10px] font-bold uppercase tracking-tight text-gray-400">
                              <span className="flex items-center gap-1"><Truck size={10} /> {driver.type === 'CGC_FLEET' ? 'FLEET' : 'EXTERNAL'}</span>
                              <span>•</span>
                              <span className="flex items-center gap-1"><Package2 size={10} /> {driver.deliveries.length} Jobs</span>
                            </div>
                          </div>
                        </div>
                        
                        <div className="flex items-center gap-3 flex-shrink-0">
                          <div className="text-right">
                            <p className="text-[8px] font-black text-gray-400 uppercase leading-none mb-1">COMPLETED</p>
                            <p className="text-sm font-black text-gray-900 leading-none">
                              {driver.deliveries.filter(d => d.status === 'DELIVERED').length} / {driver.deliveries.length}
                            </p>
                          </div>
                          <div className={`p-1.5 rounded-lg transition-colors ${isExpanded ? 'bg-[#2D6A4F]/10 text-[#2D6A4F]' : 'bg-gray-50 text-gray-400'}`}>
                            {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                          </div>
                        </div>
                      </button>

                      {/* Driver Deliveries Expansion */}
                      <AnimatePresence>
                        {isExpanded && (
                          <motion.div 
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            className="overflow-hidden border-t border-gray-100 bg-gray-50/20"
                          >
                            <div className="p-4 space-y-3">
                              {driver.deliveries.length === 0 ? (
                                <div className="py-6 text-center text-gray-400 text-xs font-semibold italic border border-dashed border-gray-200 rounded-xl bg-white">
                                  No deliveries assigned today
                                </div>
                              ) : (
                                <div className="space-y-3">
                                  {driver.deliveries.map((del, idx) => {
                                    const isDelExpanded = expandedDeliveryId === del.id;
                                    return (
                                      <div 
                                        key={del.id}
                                        className={`bg-white rounded-xl border transition-all duration-300 ${
                                          isDelExpanded ? 'border-amber-200 shadow-md ring-1 ring-amber-100' : 'border-gray-200 shadow-sm hover:border-gray-300'
                                        }`}
                                      >
                                        {/* Delivery Title Header */}
                                        <div className="px-4 py-3 flex items-center justify-between gap-3">
                                          <div className="flex items-center gap-3 flex-1 overflow-hidden">
                                            <div className="w-6 h-6 rounded-full bg-gray-50 border border-gray-200 flex items-center justify-center text-[9px] font-black text-gray-500">
                                              {idx + 1}
                                            </div>
                                            <div className="overflow-hidden">
                                              <h4 className="font-bold text-gray-900 text-xs leading-none">{del.order.spruceOrderId}</h4>
                                              <p className="text-[9px] text-gray-500 mt-1 font-bold uppercase truncate max-w-[120px]">{del.order.customerName}</p>
                                            </div>
                                          </div>

                                          <div className="flex items-center gap-2 flex-shrink-0">
                                            <StatusBadge status={del.status} />
                                            <button 
                                              onClick={() => setExpandedDeliveryId(isDelExpanded ? null : del.id)}
                                              className={`p-1 rounded-lg transition-colors ${isDelExpanded ? 'bg-amber-100 text-amber-600' : 'hover:bg-gray-100 text-gray-400'}`}
                                            >
                                              {isDelExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                                            </button>
                                          </div>
                                        </div>

                                        {/* Delivery Expanded Panel */}
                                        <AnimatePresence>
                                          {isDelExpanded && (
                                            <motion.div 
                                              initial={{ height: 0, opacity: 0 }}
                                              animate={{ height: 'auto', opacity: 1 }}
                                              exit={{ height: 0, opacity: 0 }}
                                              className="overflow-hidden border-t border-gray-50 bg-gray-50/40 p-4 space-y-4"
                                            >
                                              <div className="space-y-2">
                                                <div className="flex justify-between items-center text-xs">
                                                  <span className="text-gray-500 font-bold uppercase">Material</span>
                                                  <span className="bg-blue-50 text-blue-700 px-2 py-0.5 rounded text-[10px] font-bold border border-blue-100/50 uppercase">{del.order.product}</span>
                                                </div>
                                                <div className="flex justify-between items-center text-xs">
                                                  <span className="text-gray-500 font-bold uppercase">Quantity</span>
                                                  <span className="text-gray-900 font-black">{Number(del.order.quantity)} {del.order.unit}</span>
                                                </div>
                                              </div>

                                              <div className="space-y-2 pt-2 border-t border-gray-100">
                                                <label className="text-[9px] font-black text-gray-400 uppercase tracking-wider block">Workflow Status</label>
                                                <div className="flex gap-2">
                                                  <select 
                                                    className="text-[10px] font-black border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:ring-1 focus:ring-[#2D6A4F] bg-white cursor-pointer flex-1"
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
                                                    onClick={() => handleResendEmail(del.id)}
                                                    className="p-1.5 rounded-lg border border-gray-200 hover:bg-white text-[#2D6A4F] transition-colors"
                                                    title="Resend Link Email"
                                                  >
                                                    <Mail size={14} />
                                                  </button>
                                                  <button 
                                                    onClick={() => {
                                                      api.post('/api/dispatch/unassign', { orderId: del.order.id })
                                                        .then(() => {
                                                          toast.success('Unassigned order');
                                                          fetchBoard();
                                                        });
                                                    }}
                                                    className="px-2 py-1 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 text-[10px] font-black uppercase transition-colors"
                                                    title="Remove Assignment"
                                                  >
                                                    Unassign
                                                  </button>
                                                </div>
                                              </div>
                                              
                                              {/* Evidence Photo Section */}
                                              {(del.pickupPhotoUrl || del.deliveryPhotoUrl) && (
                                                <div className="grid grid-cols-2 gap-2 pt-2 border-t border-gray-100">
                                                  {del.pickupPhotoUrl && (
                                                    <div>
                                                      <p className="text-[8px] font-black text-gray-400 uppercase mb-1">Pickup</p>
                                                      <img src={del.pickupPhotoUrl} className="w-full h-16 object-cover rounded-lg border" alt="Pickup" />
                                                    </div>
                                                  )}
                                                  {del.deliveryPhotoUrl && (
                                                    <div>
                                                      <p className="text-[8px] font-black text-gray-400 uppercase mb-1">Delivery</p>
                                                      <img src={del.deliveryPhotoUrl} className="w-full h-16 object-cover rounded-lg border" alt="Delivery" />
                                                    </div>
                                                  )}
                                                </div>
                                              )}
                                            </motion.div>
                                          )}
                                        </AnimatePresence>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

        </div>
      )}
    </div>
  );
}