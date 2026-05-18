import React, { useState, useEffect } from 'react';
import api from '../../api/axios';
import { supabase } from '../../supabaseClient';
import { Truck, MapPin, Search, ChevronUp, ChevronDown, ChevronRight, User, GripVertical, Mail, Package2, Image as ImageIcon, Calendar, Info, RefreshCw, FileText } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'react-hot-toast';
import { FadeInUp } from '../../components/Animated';

export default function DispatchBoard() {
  const [board, setBoard] = useState({ unassignedOrders: [], unassignedDeliveries: [], drivers: [] });
  const [loading, setLoading] = useState(true);
  const [expandedDriverId, setExpandedDriverId] = useState(null);
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

  useEffect(() => {
    // Subscribe to both Order and Delivery changes to sync the board instantly
    const orderChannel = supabase
      .channel('dispatch-orders')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'Order' },
        (payload) => {
          console.log('[REALTIME] Order change received:', payload);
          fetchBoard();
        }
      )
      .subscribe();

    const deliveryChannel = supabase
      .channel('dispatch-deliveries')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'Delivery' },
        (payload) => {
          console.log('[REALTIME] Delivery change received:', payload);
          fetchBoard();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(orderChannel);
      supabase.removeChannel(deliveryChannel);
    };
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

  // Helper for real-time status colors
  const getStatusColor = (status) => {
    switch (status) {
      case 'PLACED': return '#3b82f6'; // blue-500
      case 'OUT_FOR_DELIVERY': return '#f59e0b'; // amber-500
      case 'IN_TRANSIT': return '#8b5cf6'; // violet-500
      case 'DELIVERED': return '#10b981'; // emerald-500
      case 'ON_HOLD': return '#6b7280'; // gray-500
      case 'DELAYED': return '#ef4444'; // red-500
      case 'CANCELLED': return '#b91c1c'; // red-700
      default: return '#9ca3af'; // gray-400
    }
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

  const filterDeliveries = (deliveriesList) => {
    if (!searchQuery) return deliveriesList;
    const query = searchQuery.toLowerCase();
    return deliveriesList.filter(del => 
      del.order.spruceOrderId.toLowerCase().includes(query) ||
      del.order.customerName.toLowerCase().includes(query) ||
      del.order.product.toLowerCase().includes(query)
    );
  };

  const filteredUnassignedOrders = filterOrders(board.unassignedOrders);

  // Table Skeletons matching visual guidelines
  function DriversTableSkeleton() {
    return (
      <>
        {[...Array(4)].map((_, i) => (
          <tr key={i}>
            <td className="px-6 py-4 whitespace-nowrap">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-gray-100 animate-pulse" />
                <div className="h-4 bg-gray-100 rounded w-28 animate-pulse" />
              </div>
            </td>
            <td className="px-6 py-4 whitespace-nowrap">
              <div className="h-4 bg-gray-100 rounded w-20 animate-pulse" />
            </td>
            <td className="px-6 py-4 whitespace-nowrap">
              <div className="h-6 bg-gray-100 rounded-xl w-32 animate-pulse" />
            </td>
            <td className="px-6 py-4 whitespace-nowrap text-center">
              <div className="h-4 bg-gray-100 rounded w-8 mx-auto animate-pulse" />
            </td>
            <td className="px-6 py-4 whitespace-nowrap">
              <div className="h-5 bg-gray-100 rounded-full w-16 animate-pulse" />
            </td>
            <td className="px-6 py-4 whitespace-nowrap text-right">
              <div className="w-8 h-8 bg-gray-100 rounded-lg ml-auto animate-pulse" />
            </td>
          </tr>
        ))}
      </>
    );
  }

  function UnassignedTableSkeleton() {
    return (
      <>
        {[...Array(4)].map((_, i) => (
          <tr key={i}>
            <td className="px-6 py-4 whitespace-nowrap">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-gray-100 animate-pulse" />
                <div className="h-4 bg-gray-100 rounded w-24 animate-pulse" />
              </div>
            </td>
            <td className="px-6 py-4 whitespace-nowrap">
              <div className="h-4 bg-gray-100 rounded w-32 animate-pulse" />
            </td>
            <td className="px-6 py-4 whitespace-nowrap">
              <div className="h-4 bg-gray-100 rounded w-20 animate-pulse" />
            </td>
            <td className="px-6 py-4 whitespace-nowrap">
              <div className="h-4 bg-gray-100 rounded w-16 animate-pulse" />
            </td>
            <td className="px-6 py-4 whitespace-nowrap">
              <div className="h-4 bg-gray-100 rounded w-20 animate-pulse" />
            </td>
            <td className="px-6 py-4 whitespace-nowrap">
              <div className="h-5 bg-gray-100 rounded-full w-24 animate-pulse" />
            </td>
            <td className="px-6 py-4 whitespace-nowrap text-right">
              <div className="w-20 h-6 bg-gray-100 rounded-lg ml-auto animate-pulse" />
            </td>
          </tr>
        ))}
      </>
    );
  }

  return (
    <div className="flex flex-col h-full space-y-4 max-w-[1600px] mx-auto pb-12">
      {/* Header section styled 100% identically to Invoices Page */}
      <FadeInUp>
        <div className="sm:flex sm:items-center justify-between bg-white p-4 rounded-xl border border-gray-200 shadow-sm select-none">
          <div className="sm:flex-auto">
            <h1 className="text-2xl font-semibold text-gray-900">Dispatch Board</h1>
            <p className="mt-2 text-sm text-gray-700">
              Manage daily assignments and track driver workflows with real-time drag & drop.
            </p>
          </div>
          <div className="mt-4 sm:ml-16 sm:mt-0 sm:flex-none flex items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input 
                type="text" 
                placeholder="Search orders, customers..." 
                className="pl-10 pr-4 py-2 border rounded-xl text-sm outline-none focus:ring-2 focus:ring-green-100 transition-all border-gray-200 w-64 bg-white" 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <button 
              onClick={fetchBoard}
              className="p-2 border border-gray-200 rounded-xl text-gray-500 hover:text-gray-900 hover:bg-gray-50 transition-all shadow-sm bg-white"
              title="Refresh Board"
            >
              <RefreshCw size={18} className={loading ? "animate-spin" : ""} />
            </button>
          </div>
        </div>
      </FadeInUp>

      {/* TOP SECTION: DRIVERS EXCEL SPREADSHEET TABLE */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden flex flex-col">
        <div className="bg-gray-50/50 px-6 py-4 border-b border-gray-200/80 flex justify-between items-center select-none">
          <div>
            <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
              Active Drivers
            </h3>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th scope="col" className="px-6 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider w-64 select-none">Driver</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider w-40 select-none">Type</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider select-none">Active Assignments</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider w-32 text-center select-none">Completed</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider w-32 select-none">Status</th>
                <th scope="col" className="px-6 py-3 text-right text-xs font-bold text-gray-500 uppercase tracking-wider w-24 select-none">Action</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {loading && board.drivers.length === 0 ? (
                <DriversTableSkeleton />
              ) : board.drivers.length === 0 ? (
                <tr><td colSpan="6" className="px-6 py-12 text-center text-gray-500">No active drivers found.</td></tr>
              ) : (
                board.drivers.map(driver => {
                  const isExpanded = expandedDriverId === driver.id;
                  const isDragOverTarget = activeDragTargetDriverId === driver.id;
                  const filteredDeliveries = filterDeliveries(driver.deliveries);
                  const completedJobs = driver.deliveries.filter(d => d.status === 'DELIVERED').length;
                  const totalJobs = driver.deliveries.length;
                  
                  return (
                    <React.Fragment key={driver.id}>
                      <tr 
                        onDragOver={(e) => handleDragOverDriver(e, driver.id)}
                        onDragLeave={() => handleDragLeaveDriver(driver.id)}
                        onDrop={(e) => handleDropOnDriver(e, driver.id)}
                        className={`hover:bg-gray-50/50 transition-colors group relative ${
                          isDragOverTarget ? 'bg-green-50/30' : ''
                        } ${isExpanded ? 'bg-gray-50/30' : ''}`}
                      >
                        {/* Driver Column */}
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex items-center gap-3">
                             <div className="p-2 bg-gray-100 rounded-lg group-hover:bg-green-100 transition-colors flex-shrink-0">
                                <Truck className="w-5 h-5 text-gray-400 group-hover:text-green-600" />
                             </div>
                             <div className="text-sm font-bold text-gray-900 select-none truncate max-w-[180px]">{driver.name}</div>
                          </div>
                        </td>

                        {/* Type Column */}
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 font-medium select-none">
                          {driver.type === 'CGC_FLEET' ? 'CGC Fleet' : 'External Contractor'}
                        </td>

                        {/* Active Assignments Badge Column (Static) */}
                        <td className="px-6 py-4">
                          <div className="flex flex-wrap gap-2 items-center">
                            {filteredDeliveries.length === 0 ? (
                              <span className="text-xs text-gray-400 font-semibold italic select-none">
                                No assignments — drag orders onto this row to assign
                              </span>
                            ) : (
                              <div className="flex items-center gap-2 bg-gray-50 border border-gray-200/80 rounded-xl px-3 py-1.5 text-xs font-bold text-gray-600 select-none shadow-sm">
                                <Package2 size={14} className="text-gray-400" />
                                <span>{filteredDeliveries.length} {filteredDeliveries.length === 1 ? 'Order' : 'Orders'} Assigned</span>
                              </div>
                            )}
                          </div>
                        </td>

                        {/* Completed Column */}
                        <td className="px-6 py-4 whitespace-nowrap text-center text-sm font-bold text-gray-900 select-none">
                          {completedJobs}/{totalJobs}
                        </td>

                        {/* Status Column */}
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                            driver.deliveries.length > 0 
                              ? 'bg-green-100 text-green-800 border border-green-200' 
                              : 'bg-gray-100 text-gray-800 border border-gray-200'
                          }`}>
                            {driver.deliveries.length > 0 ? 'Active' : 'Idle'}
                          </span>
                        </td>

                        {/* Action Column (Row Expander Trigger) */}
                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (filteredDeliveries.length > 0) {
                                setExpandedDriverId(isExpanded ? null : driver.id);
                              } else {
                                toast.error('No assignments assigned to this driver');
                              }
                            }}
                            className={`transition-all p-2 rounded-lg ${
                              isExpanded 
                                ? 'bg-green-50 text-green-600' 
                                : 'text-gray-400 hover:text-green-600 hover:bg-green-50'
                            }`}
                          >
                             <ChevronRight className={`w-5 h-5 transition-transform duration-200 ${
                               isExpanded ? 'rotate-90 text-green-600 font-extrabold' : 'text-green-500'
                             }`} />
                          </button>
                        </td>
                      </tr>

                      {/* Expanded Sub-Row displaying Assigned Orders at 100% Screen Width and full height */}
                      <AnimatePresence initial={false}>
                        {isExpanded && (
                          <tr>
                            <td colSpan="6" className="px-6 py-4 bg-gray-50/40 border-t border-b border-gray-100">
                              <motion.div
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: 'auto', opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                transition={{ duration: 0.2 }}
                                className="overflow-hidden"
                              >
                                <div className="border border-gray-200 rounded-xl bg-white shadow-sm overflow-hidden flex flex-col">
                                  {/* Sub-row Header */}
                                  <div className="bg-gray-50/60 px-4 py-2 border-b border-gray-200 flex justify-between items-center select-none">
                                    <span className="text-[10px] font-black text-gray-500 uppercase tracking-wider">
                                      Assigned Deliveries for {driver.name} ({filteredDeliveries.length})
                                    </span>
                                    <span className="text-[9px] text-gray-400 font-semibold">
                                      Drag any order row down to the pool to unassign
                                    </span>
                                  </div>

                                  {/* List of Orders in 100% full-screen width table format */}
                                  <table className="min-w-full divide-y divide-gray-100">
                                    <tbody className="divide-y divide-gray-100 bg-white">
                                      {filteredDeliveries.map((del) => {
                                        return (
                                          <React.Fragment key={del.id}>
                                            <tr
                                              draggable
                                              onDragStart={(e) => {
                                                handleDragStart(e, del.order.id, driver.id);
                                              }}
                                              onDragEnd={handleDragEnd}
                                              className={`hover:bg-gray-50/50 transition-colors cursor-grab active:cursor-grabbing group/item relative ${
                                                draggingOrderId === del.order.id ? 'opacity-40 bg-gray-50' : ''
                                              }`}
                                            >
                                              {/* Order ID Column */}
                                              <td className="px-6 py-4 whitespace-nowrap w-48">
                                                <div className="flex items-center gap-2">
                                                  <div className="p-1.5 bg-gray-100 rounded-lg text-gray-400 group-hover/item:text-green-600 group-hover/item:bg-green-100 transition-colors flex-shrink-0">
                                                    <Package2 className="w-4 h-4" />
                                                  </div>
                                                  <div className="text-xs font-black text-gray-900 tracking-wider flex items-center gap-1.5 uppercase select-none">
                                                    <GripVertical size={12} className="text-gray-300 group-hover/item:text-gray-400 transition-colors flex-shrink-0" />
                                                    {del.order.spruceOrderId}
                                                  </div>
                                                </div>
                                              </td>

                                              {/* Customer Column */}
                                              <td className="px-6 py-4 whitespace-nowrap text-xs text-gray-600 font-bold select-none w-64">
                                                {del.order.customerName}
                                              </td>

                                              {/* Product Column */}
                                              <td className="px-6 py-4 whitespace-nowrap w-40">
                                                <span className="bg-blue-50 text-blue-700 px-2 py-0.5 rounded text-[9px] font-black uppercase border border-blue-100/50 select-none">
                                                  {del.order.product}
                                                </span>
                                              </td>

                                              {/* Quantity Column */}
                                              <td className="px-6 py-4 whitespace-nowrap text-xs text-gray-500 font-bold select-none w-32">
                                                {Number(del.order.quantity)} {del.order.unit}
                                              </td>

                                              {/* Status Badge Column */}
                                              <td className="px-6 py-4 whitespace-nowrap w-48">
                                                <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[9px] font-black uppercase tracking-wider ${
                                                  del.status === 'DELIVERED' 
                                                    ? 'bg-green-100 text-green-800 border border-green-200' 
                                                    : 'bg-yellow-100 text-yellow-800 border border-yellow-200'
                                                }`}>
                                                  {del.status.replace('_', ' ')}
                                                </span>
                                              </td>

                                              {/* Actions Inline Column */}
                                              <td className="px-6 py-4 whitespace-nowrap text-right text-xs font-bold w-64">
                                                <div className="flex items-center justify-end gap-2">
                                                  <select 
                                                    className="text-[10px] font-black border border-gray-200 rounded-lg px-2 py-1 outline-none focus:ring-1 focus:ring-green-500 bg-white cursor-pointer text-gray-700"
                                                    value={del.status}
                                                    onChange={(e) => {
                                                      handleStatusUpdate(del.id, e.target.value);
                                                    }}
                                                    onClick={(e) => e.stopPropagation()} // prevent row drag trigger on click
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
                                                    onClick={(e) => {
                                                      e.stopPropagation();
                                                      handleResendEmail(del.id);
                                                    }}
                                                    className="p-1.5 rounded-lg border border-gray-205 hover:bg-gray-50 text-green-600 transition-colors bg-white"
                                                    title="Resend Link Email"
                                                  >
                                                    <Mail size={12} />
                                                  </button>

                                                  <button 
                                                    onClick={(e) => {
                                                      e.stopPropagation();
                                                      api.post('/api/dispatch/unassign', { orderId: del.order.id })
                                                        .then(() => {
                                                          toast.success('Unassigned order');
                                                          fetchBoard();
                                                        });
                                                    }}
                                                    className="px-2.5 py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 text-[9px] font-black uppercase transition-colors bg-white"
                                                    title="Remove Assignment"
                                                  >
                                                    Unassign
                                                  </button>
                                                </div>
                                              </td>
                                            </tr>

                                            {/* Evidence Photos Sub-Row inside Expanded Table */}
                                            {(del.pickupPhotoUrl || del.deliveryPhotoUrl) && (
                                              <tr className="bg-gray-50/10 select-none">
                                                <td colSpan="6" className="px-6 py-2 border-b border-gray-100">
                                                  <div className="flex gap-6 items-center pl-8 py-1">
                                                    {del.pickupPhotoUrl && (
                                                      <div className="flex gap-2 items-center">
                                                        <span className="text-[9px] font-black text-gray-400 uppercase">Pickup photo:</span>
                                                        <img src={del.pickupPhotoUrl} className="w-20 h-10 object-cover rounded-lg border hover:scale-105 transition-all cursor-zoom-in" alt="Pickup Evidence" />
                                                      </div>
                                                    )}
                                                    {del.deliveryPhotoUrl && (
                                                      <div className="flex gap-2 items-center">
                                                        <span className="text-[9px] font-black text-gray-400 uppercase">Delivery photo:</span>
                                                        <img src={del.deliveryPhotoUrl} className="w-20 h-10 object-cover rounded-lg border hover:scale-105 transition-all cursor-zoom-in" alt="Delivery Evidence" />
                                                      </div>
                                                    )}
                                                  </div>
                                                </td>
                                              </tr>
                                            )}
                                          </React.Fragment>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              </motion.div>
                            </td>
                          </tr>
                        )}
                      </AnimatePresence>
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* BOTTOM SECTION: UNASSIGNED ORDERS POOL */}
      <div 
        onDragOver={handleDragOverUnassigned}
        onDragLeave={handleDragLeaveUnassigned}
        onDrop={handleDropOnUnassigned}
        className={`bg-white rounded-xl border shadow-sm overflow-hidden flex flex-col transition-all duration-300 ${
          isOverUnassignedDropZone 
            ? 'border-green-600 ring-4 ring-green-600/10 bg-green-50/5' 
            : 'border-gray-200'
        }`}
      >
        <div className="bg-gray-50/50 px-6 py-4 border-b border-gray-200 flex justify-between items-center select-none">
          <div>
            <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse"></span>
              Unassigned Orders Pool
            </h3>
          </div>
          {isOverUnassignedDropZone && (
            <motion.div 
              initial={{ scale: 0.9 }}
              animate={{ scale: 1 }}
              className="text-xs font-extrabold text-green-600 bg-green-600/10 px-3 py-1 rounded-lg uppercase tracking-wider animate-bounce"
            >
              Drop here to Unassign!
            </motion.div>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th scope="col" className="px-6 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider select-none">Order</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider select-none">Customer</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider select-none">Product</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider select-none">Quantity</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider select-none">Date</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider select-none">Status</th>
                <th scope="col" className="px-6 py-3 text-right text-xs font-bold text-gray-500 uppercase tracking-wider select-none">Assign</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {loading && board.unassignedOrders.length === 0 ? (
                <UnassignedTableSkeleton />
              ) : filteredUnassignedOrders.length === 0 ? (
                <tr>
                  <td colSpan="7" className="px-6 py-12 text-center text-gray-500 select-none">
                    <Package2 size={36} className="mx-auto text-gray-300 mb-2" />
                    <p className="font-semibold text-sm">No unassigned orders found.</p>
                    <p className="text-xs text-gray-400 mt-1">All orders are fully dispatched!</p>
                  </td>
                </tr>
              ) : (
                filteredUnassignedOrders.map(order => (
                  <tr 
                    key={order.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, order.id, null)}
                    onDragEnd={handleDragEnd}
                    className={`hover:bg-gray-50/50 transition-colors cursor-grab active:cursor-grabbing group relative ${
                      draggingOrderId === order.id ? 'opacity-40 bg-gray-50' : ''
                    }`}
                  >
                    {/* Order Column */}
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center gap-3">
                         <div className="p-2 bg-gray-100 rounded-lg group-hover:bg-green-100 transition-colors flex-shrink-0">
                            <Package2 className="w-5 h-5 text-gray-400 group-hover:text-green-600" />
                         </div>
                         <div className="text-sm font-bold text-gray-900 tracking-wider flex items-center gap-1.5 uppercase select-none">
                           <GripVertical size={14} className="text-gray-300 group-hover:text-gray-400 transition-colors flex-shrink-0" />
                           {order.spruceOrderId}
                         </div>
                      </div>
                    </td>

                    {/* Customer Column */}
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 font-medium select-none">
                      {order.customerName}
                    </td>

                    {/* Product Column */}
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className="bg-blue-50 text-blue-700 px-2 py-0.5 rounded text-[10px] font-bold uppercase border border-blue-100/50 select-none">
                        {order.product}
                      </span>
                    </td>

                    {/* Quantity Column */}
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 font-bold select-none">
                      {Number(order.quantity)} {order.unit}
                    </td>

                    {/* Date Column */}
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 select-none">
                      {new Date(order.createdAt).toLocaleDateString()}
                    </td>

                    {/* Status Column */}
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-yellow-100 text-yellow-800 border border-yellow-200 select-none">
                        PENDING
                      </span>
                    </td>

                    {/* Assign Column */}
                    <td className="px-6 py-4 whitespace-nowrap text-right">
                      <select
                        className="border border-gray-200 rounded-lg px-2 py-1 text-[10px] font-bold bg-white focus:ring-1 focus:ring-green-500 outline-none cursor-pointer text-gray-600 hover:border-gray-300 transition-all"
                        onChange={(e) => {
                          if(e.target.value) {
                            const driverObj = board.drivers.find(d => d.id === e.target.value);
                            if (driverObj) {
                              api.post('/api/dispatch/assign', { orderId: order.id, driverId: driverObj.id })
                                .then(() => {
                                  toast.success(`Assigned ${order.spruceOrderId} to ${driverObj.name}`);
                                  fetchBoard();
                                });
                            }
                          }
                        }}
                        onClick={(e) => e.stopPropagation()} // prevent row drag trigger on dropdown click
                        value=""
                      >
                        <option value="" disabled>Quick Assign...</option>
                        {board.drivers.map(d => (
                          <option key={d.id} value={d.id}>{d.name}</option>
                        ))}
                      </select>
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