import React, { useState, useEffect, useCallback } from 'react';
import api from '../../api/axios';
import { Truck, MapPin, Search, ChevronUp, ChevronDown, ChevronRight, User, GripVertical, Package2, Image as ImageIcon, Calendar, Info, RefreshCw, FileText } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'react-hot-toast';
import { FadeInUp } from '../../components/Animated';
import { Badge, Button, EmptyState, Input, PageHeader, StatusBadge } from '../../components/ui';
import { useIntervalRefresh } from '../../hooks/useIntervalRefresh';
import { businessDayOffset, formatDate } from '../../lib/date';
import { cn } from '../../lib/cn';
import { isTerminal, statusErrorMessage, statusOptionsFor } from '../../lib/deliveryTransitions';
import { formatQuantity } from '../../lib/quantity';
import { mergeUnassignedOrders } from '../../lib/dispatchBoard';
import { resolveDocumentUrl } from '../../lib/apiBase';

export default function DispatchBoard() {
  const [board, setBoard] = useState({ unassignedOrders: [], unassignedDeliveries: [], drivers: [] });
  const [loading, setLoading] = useState(true);
  const [expandedDriverId, setExpandedDriverId] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');

  const [draggingOrderId, setDraggingOrderId] = useState(null);
  const [draggingFromDriverId, setDraggingFromDriverId] = useState(null);
  const [activeDragTargetDriverId, setActiveDragTargetDriverId] = useState(null);
  const [isOverUnassignedDropZone, setIsOverUnassignedDropZone] = useState(false);

  // The pool defaults to today's imports. Older orders are still reachable, but
  // they no longer sit in the way of the work being dispatched now.
  const [dateFilter, setDateFilter] = useState('today'); // 'today' | 'yesterday' | 'select'
  const [selectedDate, setSelectedDate] = useState(''); // 'YYYY-MM-DD'

  const poolDate =
    dateFilter === 'today' ? businessDayOffset(0)
    : dateFilter === 'yesterday' ? businessDayOffset(-1)
    : selectedDate;

  const awaitingDateChoice = dateFilter === 'select' && !selectedDate;

  const fetchBoard = useCallback(async (isBackgroundSync = false) => {
    if (awaitingDateChoice) {
      setLoading(false);
      return;
    }

    try {
      if (!isBackgroundSync) setLoading(true);

      // Express, not the fetch-cgc-data Edge function.
      //
      // The deployed Edge function predates the day-scoping change and ignored
      // the `date` parameter entirely: it returned 1,000 unassigned orders
      // spanning seven different import days, which the board rendered as
      // 32,403 DOM nodes including 1,000 selects and 7,000 options. That render,
      // not the network, is what made this the slowest screen in the app.
      //
      // /api/dispatch applies the business-day range server-side.
      const { data } = await api.get('/api/dispatch', { params: { date: poolDate } });

      const drivers = (data?.drivers || []).map(d => ({
        ...d,
        deliveries: [...(d.deliveries || [])].sort((a, b) => (a.priority || 0) - (b.priority || 0))
      }));
      setBoard({
        ...data,
        unassignedOrders: mergeUnassignedOrders(
          data?.unassignedOrders,
          data?.unassignedDeliveries,
        ),
        drivers,
      });
    } catch (e) {
      console.error(e);
      if (!isBackgroundSync) toast.error('Failed to fetch dispatch board');
    } finally {
      setLoading(false);
    }
  }, [awaitingDateChoice, poolDate]);

  useEffect(() => {
    fetchBoard();
    // Refetch when the day being dispatched changes.
  }, [fetchBoard]);

  useIntervalRefresh(
    () => {
      fetchBoard(true);
    },
    10_000,
    { enabled: !draggingOrderId }
  );

  const handleStatusUpdate = async (deliveryId, newStatus) => {
    // Optimistic UI update
    setBoard(prev => {
      let updatedDrivers = prev.drivers.map(d => ({
        ...d,
        deliveries: d.deliveries.map(del =>
          del.id === deliveryId ? { ...del, status: newStatus } : del
        )
      }));
      return { ...prev, drivers: updatedDrivers };
    });

    try {
      api.patch(`/api/deliveries/${deliveryId}/status`, { status: newStatus })
        .then(() => {
          toast.success(`Status updated to ${newStatus}`);
        })
        .catch((e) => {
          console.error(e);
          // Surface the server's actual reason rather than a generic failure.
          toast.error(statusErrorMessage(e));
          fetchBoard(); // Revert optimistic update
        });
    } catch (e) {
      console.error(e);
      toast.error(statusErrorMessage(e));
      fetchBoard();
    }
  };

  // Drag and Drop Logic
  const handleAutoScroll = (e) => {
    if (!draggingOrderId) return;
    const scrollThreshold = 100;
    const scrollAmount = 20;

    if (e.clientY < scrollThreshold) {
      window.scrollBy(0, -scrollAmount);
    } else if (window.innerHeight - e.clientY < scrollThreshold) {
      window.scrollBy(0, scrollAmount);
    }
  };

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
      setExpandedDriverId(targetDriverId);
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
              // Mirrors DispatchService.assignDriver: the new stop lands at the
              // end of the run. If this drifts from the server the row jumps
              // position on the next refresh.
              const maxPriority = updatedDeliveries.length > 0
                ? Math.max(...updatedDeliveries.map(d => d.priority || 0))
                : 0;

              updatedDeliveries.push({
                id: `temp-${Date.now()}`,
                orderId,
                driverId: targetDriverId,
                status: 'PLACED',
                priority: maxPriority + 1,
                order: orderObj,
                history: []
              });
              updatedDeliveries.sort((a, b) => (a.priority || 0) - (b.priority || 0));
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

  const handleDropOnDelivery = async (e, targetDriverId, targetOrderId) => {
    e.preventDefault();
    e.stopPropagation(); // prevent driver drop handler from catching this
    const orderId = draggingOrderId || e.dataTransfer.getData('text/plain');
    if (!orderId) return;

    if (orderId === targetOrderId) {
      handleDragEnd();
      return;
    }

    if (draggingFromDriverId !== targetDriverId) {
      // It's a cross-driver assignment but dropped exactly on a row
      // We can just fallback to the normal driver assignment
      return handleDropOnDriver(e, targetDriverId);
    }

    try {
      const driver = board.drivers.find(d => d.id === targetDriverId);
      if (!driver) return;
      const deliveriesCopy = [...driver.deliveries];
      const draggedIndex = deliveriesCopy.findIndex(d => d.order.id === orderId);
      const targetIndex = deliveriesCopy.findIndex(d => d.order.id === targetOrderId);

      if (draggedIndex === -1 || targetIndex === -1) return;

      const [draggedItem] = deliveriesCopy.splice(draggedIndex, 1);
      deliveriesCopy.splice(targetIndex, 0, draggedItem);

      // Optimistic update
      setBoard(prev => ({
        ...prev,
        drivers: prev.drivers.map(d => d.id === targetDriverId ? { ...d, deliveries: deliveriesCopy } : d)
      }));

      // Call API
      await api.post('/api/dispatch/reorder', {
        driverId: targetDriverId,
        deliveryIds: deliveriesCopy.map(d => d.id)
      });
      toast.success('Orders reordered');
    } catch (err) {
      console.error(err);
      toast.error('Failed to reorder deliveries');
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

  const poolDateLabel =
    dateFilter === 'today' ? 'today'
    : dateFilter === 'yesterday' ? 'yesterday'
    : formatDate(`${selectedDate}T00:00:00`, { dateStyle: 'long' });

  // Table Skeletons matching visual guidelines
  function DriversTableSkeleton() {
    return (
      <>
        {[...Array(4)].map((_, i) => (
          <tr key={i}>
            <td className="px-6 py-4 whitespace-nowrap">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-control bg-ink/[0.06] animate-pulse" />
                <div className="h-4 bg-ink/[0.06] rounded w-28 animate-pulse" />
              </div>
            </td>
            <td className="px-6 py-4 whitespace-nowrap">
              <div className="h-4 bg-ink/[0.06] rounded w-20 animate-pulse" />
            </td>
            <td className="px-6 py-4 whitespace-nowrap">
              <div className="h-6 bg-ink/[0.06] rounded-control w-32 animate-pulse" />
            </td>
            <td className="px-6 py-4 whitespace-nowrap text-center">
              <div className="h-4 bg-ink/[0.06] rounded w-8 mx-auto animate-pulse" />
            </td>
            <td className="px-6 py-4 whitespace-nowrap">
              <div className="h-5 bg-ink/[0.06] rounded-full w-16 animate-pulse" />
            </td>
            <td className="px-6 py-4 whitespace-nowrap text-right">
              <div className="w-8 h-8 bg-ink/[0.06] rounded-control ml-auto animate-pulse" />
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
                <div className="w-8 h-8 rounded-control bg-ink/[0.06] animate-pulse" />
                <div className="h-4 bg-ink/[0.06] rounded w-24 animate-pulse" />
              </div>
            </td>
            <td className="px-6 py-4 whitespace-nowrap">
              <div className="h-4 bg-ink/[0.06] rounded w-32 animate-pulse" />
            </td>
            <td className="px-6 py-4 whitespace-nowrap">
              <div className="h-4 bg-ink/[0.06] rounded w-20 animate-pulse" />
            </td>
            <td className="px-6 py-4 whitespace-nowrap">
              <div className="h-4 bg-ink/[0.06] rounded w-16 animate-pulse" />
            </td>
            <td className="px-6 py-4 whitespace-nowrap">
              <div className="h-4 bg-ink/[0.06] rounded w-20 animate-pulse" />
            </td>
            <td className="px-6 py-4 whitespace-nowrap">
              <div className="h-5 bg-ink/[0.06] rounded-full w-24 animate-pulse" />
            </td>
            <td className="px-6 py-4 whitespace-nowrap text-right">
              <div className="w-20 h-6 bg-ink/[0.06] rounded-control ml-auto animate-pulse" />
            </td>
          </tr>
        ))}
      </>
    );
  }

  return (
    <div
      className="flex flex-col h-full space-y-4 max-w-[1600px] mx-auto pb-12"
      onDragOver={handleAutoScroll}
    >
      {/* Header section styled 100% identically to Invoices Page */}
      <FadeInUp>
        <PageHeader
          title="Dispatch board"
          subtitle="Assign today's orders to drivers. Drag a row onto a driver, or drop it back in the pool."
          actions={
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1 bg-ink/[0.05] p-1 rounded-control">
                {[
                  ['today', 'Today'],
                  ['yesterday', 'Yesterday'],
                  ['select', 'Select date'],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setDateFilter(id)}
                    className={cn(
                      'px-3 py-1.5 rounded-control text-[13px] font-semibold transition-colors',
                      dateFilter === id
                        ? 'bg-surface text-brand shadow-card border border-line'
                        : 'text-muted hover:text-ink'
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {dateFilter === 'select' && (
                <Input
                  type="date"
                  className="tabular w-44"
                  aria-label="Pool date"
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                />
              )}

              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
                <Input
                  type="text"
                  placeholder="Search orders, customers..."
                  className="pl-10 w-64"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <Button
                size="icon"
                onClick={fetchBoard}
                title="Refresh Board"
              >
                <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
              </Button>
            </div>
          }
        />
      </FadeInUp>

      {/* TOP SECTION: DRIVERS EXCEL SPREADSHEET TABLE */}
      <div className="bg-surface rounded-card border border-line shadow-card overflow-hidden flex flex-col">
        <div className="bg-ink/[0.03] px-6 py-4 border-b border-line flex justify-between items-center select-none">
          <div>
            <h3 className="text-sm font-bold text-ink flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-brand animate-pulse"></span>
              Active Drivers
            </h3>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-line">
            <thead className="bg-ink/[0.03]">
              <tr>
                <th scope="col" className="px-6 py-3 text-left text-[12.5px] font-bold text-muted w-64 select-none">Driver</th>
                <th scope="col" className="px-6 py-3 text-left text-[12.5px] font-bold text-muted w-40 select-none">Type</th>
                <th scope="col" className="px-6 py-3 text-left text-[12.5px] font-bold text-muted select-none">Active Assignments</th>
                <th scope="col" className="px-6 py-3 text-left text-[12.5px] font-bold text-muted w-32 text-center select-none">Completed</th>
                <th scope="col" className="px-6 py-3 text-left text-[12.5px] font-bold text-muted w-32 select-none">Status</th>
                <th scope="col" className="px-6 py-3 text-right text-[12.5px] font-bold text-muted w-24 select-none">Action</th>
              </tr>
            </thead>
            <tbody className="bg-surface divide-y divide-line">
              {loading && board.drivers.length === 0 ? (
                <DriversTableSkeleton />
              ) : board.drivers.length === 0 ? (
                <tr><td colSpan="6"><EmptyState title="No active drivers" message="Add a driver on the Drivers page, then come back to assign orders." /></td></tr>
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
                        className={`hover:bg-brand/[0.04] transition-colors group relative ${isDragOverTarget ? 'bg-brand/[0.06]' : ''
                          } ${isExpanded ? 'bg-ink/[0.03]' : ''}`}
                      >
                        {/* Driver Column */}
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex items-center gap-3">
                            <div className="p-2 bg-ink/[0.06] rounded-control group-hover:bg-brand/10 transition-colors flex-shrink-0">
                              <Truck className="w-5 h-5 text-muted group-hover:text-brand" />
                            </div>
                            <div>
                              <div className="text-sm font-bold text-ink select-none truncate max-w-[180px]">{driver.name}</div>
                              {driver.type === 'INDEPENDENT' && driver.companyName && (
                                <div className="text-[12.5px] text-muted font-medium select-none truncate max-w-[180px]">{driver.companyName}</div>
                              )}
                            </div>
                          </div>
                        </td>

                        {/* Type Column */}
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-muted font-medium select-none">
                          {driver.type === 'CGC_FLEET' ? 'CGC Fleet' : 'External Contractor'}
                        </td>

                        {/* Active Assignments Badge Column (Static) */}
                        <td className="px-6 py-4">
                          <div className="flex flex-wrap gap-2 items-center">
                            {filteredDeliveries.length === 0 ? (
                              <span className="text-[12.5px] text-muted font-semibold italic select-none">
                                No assignments — drag orders onto this row to assign
                              </span>
                            ) : (
                              <div className="flex items-center gap-2 bg-ink/[0.03] border border-line rounded-control px-3 py-1.5 text-[12.5px] font-bold text-muted select-none shadow-card">
                                <Package2 size={14} className="text-muted" />
                                <span>{filteredDeliveries.length} {filteredDeliveries.length === 1 ? 'Order' : 'Orders'} Assigned</span>
                              </div>
                            )}
                          </div>
                        </td>

                        {/* Completed Column */}
                        <td className="px-6 py-4 whitespace-nowrap text-center text-sm font-bold text-ink select-none">
                          {completedJobs}/{totalJobs}
                        </td>

                        {/* Status Column */}
                        <td className="px-6 py-4 whitespace-nowrap">
                          <Badge tone={driver.deliveries.length > 0 ? 'good' : 'neutral'}>
                            {driver.deliveries.length > 0 ? 'Active' : 'Idle'}
                          </Badge>
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
                            className={`transition-all p-2 rounded-control ${isExpanded
                                ? 'bg-brand/10 text-brand'
                                : 'text-muted hover:text-brand hover:bg-brand/10'
                              }`}
                          >
                            <ChevronRight className={`w-5 h-5 transition-transform duration-200 ${isExpanded ? 'rotate-90 text-brand font-bold' : 'text-brand'
                              }`} />
                          </button>
                        </td>
                      </tr>

                      {/* Expanded Sub-Row displaying Assigned Orders at 100% Screen Width and full height */}
                      <AnimatePresence initial={false}>
                        {isExpanded && (
                          <tr>
                            <td colSpan="6" className="px-6 py-4 bg-ink/[0.03] border-t border-b border-line">
                              <motion.div
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: 'auto', opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                transition={{ duration: 0.2 }}
                                className="overflow-hidden"
                              >
                                <div className="border border-line rounded-control bg-surface shadow-card overflow-hidden flex flex-col">
                                  {/* Sub-row Header */}
                                  <div className="bg-ink/[0.03] px-4 py-2 border-b border-line flex justify-between items-center select-none">
                                    <span className="text-[12.5px] font-bold text-muted">
                                      Assigned Deliveries for {driver.name} ({filteredDeliveries.length})
                                    </span>
                                    <span className="text-[12.5px] text-muted font-semibold">
                                      Drag any order row down to the pool to unassign
                                    </span>
                                  </div>

                                  {/* List of Orders in 100% full-screen width table format */}
                                  <table className="min-w-full divide-y divide-line">
                                    <tbody className="divide-y divide-line bg-surface">
                                      {filteredDeliveries.map((del) => {
                                        return (
                                          <React.Fragment key={del.id}>
                                            <tr
                                              draggable
                                              onDragStart={(e) => {
                                                handleDragStart(e, del.order.id, driver.id);
                                              }}
                                              onDragOver={(e) => e.preventDefault()}
                                              onDrop={(e) => handleDropOnDelivery(e, driver.id, del.order.id)}
                                              onDragEnd={handleDragEnd}
                                              className={`hover:bg-brand/[0.04] transition-colors cursor-grab active:cursor-grabbing group/item relative ${draggingOrderId === del.order.id ? 'opacity-40 bg-ink/[0.03]' : ''
                                                }`}
                                            >
                                              {/* Order ID Column */}
                                              <td className="px-6 py-4 whitespace-nowrap w-48">
                                                <div className="flex items-center gap-2">
                                                  <div className="p-1.5 bg-ink/[0.06] rounded-control text-muted group-hover/item:text-brand group-hover/item:bg-brand/10 transition-colors flex-shrink-0">
                                                    <Package2 className="w-4 h-4" />
                                                  </div>
                                                  <div className="text-[12.5px] font-bold text-ink flex items-center gap-1.5 select-none">
                                                    <GripVertical size={12} className="text-muted group-hover/item:text-muted transition-colors flex-shrink-0" />
                                                    {del.order.spruceOrderId}
                                                  </div>
                                                </div>
                                              </td>

                                              {/* Customer Column */}
                                              <td className="px-6 py-4 whitespace-nowrap text-[12.5px] text-muted font-bold select-none w-64">
                                                {del.order.customerName}
                                              </td>

                                              {/* Product Column */}
                                              <td className="px-6 py-4 whitespace-nowrap w-40">
                                                <Badge tone="neutral">{del.order.product}</Badge>
                                              </td>

                                              {/* Quantity Column */}
                                              <td className="px-6 py-4 whitespace-nowrap text-[12.5px] text-muted font-bold select-none w-32">
                                                {formatQuantity(del.order.quantity, del.order.unit)}
                                              </td>

                                              {/* Status Badge Column */}
                                              <td className="px-6 py-4 whitespace-nowrap w-48">
                                                <StatusBadge status={del.status} />
                                              </td>

                                              {/* Actions Inline Column */}
                                              <td className="px-6 py-4 whitespace-nowrap text-right text-[12.5px] font-bold w-64">
                                                <div className="flex items-center justify-end gap-2">
                                                  {/* Only the moves the server will
                                                      accept from this stop's current
                                                      state, that state listed first. */}
                                                  <select
                                                    className="text-[12.5px] font-bold border border-line rounded-control px-2 py-1 outline-none focus:ring-1 focus:ring-brand bg-surface cursor-pointer text-ink disabled:opacity-50 disabled:cursor-not-allowed"
                                                    value={del.status}
                                                    disabled={isTerminal(del.status)}
                                                    title={isTerminal(del.status)
                                                      ? `${del.status} is final and cannot be changed here`
                                                      : 'Change delivery status'}
                                                    onChange={(e) => {
                                                      handleStatusUpdate(del.id, e.target.value);
                                                    }}
                                                    onClick={(e) => e.stopPropagation()} // prevent row drag trigger on click
                                                  >
                                                    {statusOptionsFor(del).map(option => (
                                                      <option key={option.value} value={option.value} disabled={option.disabled}>
                                                        {option.label}
                                                      </option>
                                                    ))}
                                                  </select>


                                                  <button
                                                    onClick={(e) => {
                                                      e.stopPropagation();
                                                      api.post('/api/dispatch/unassign', { orderId: del.order.id })
                                                        .then(() => {
                                                          toast.success('Unassigned order');
                                                          fetchBoard();
                                                        });
                                                    }}
                                                    className="px-2.5 py-1.5 rounded-control border border-clay/30 text-clay hover:bg-clay/10 text-[12.5px] font-bold transition-colors bg-surface"
                                                    title="Remove Assignment"
                                                  >
                                                    Unassign
                                                  </button>
                                                </div>
                                              </td>
                                            </tr>

                                            {/* Evidence Photos Sub-Row inside Expanded Table */}
                                            {(del.pickupPhotoUrl || del.deliveryPhotoUrl) && (
                                              <tr className="bg-ink/[0.02] select-none">
                                                <td colSpan="6" className="px-6 py-2 border-b border-line">
                                                  <div className="flex gap-6 items-center pl-8 py-1">
                                                    {del.pickupPhotoUrl && (
                                                      <div className="flex gap-2 items-center">
                                                        <span className="text-[12.5px] font-bold text-muted">Pickup photo:</span>
                                                        <img src={resolveDocumentUrl(del.pickupPhotoUrl)} className="w-20 h-10 object-cover rounded-control border hover:scale-105 transition-all cursor-zoom-in" alt="Pickup Evidence" />
                                                      </div>
                                                    )}
                                                    {del.deliveryPhotoUrl && (
                                                      <div className="flex gap-2 items-center">
                                                        <span className="text-[12.5px] font-bold text-muted">Delivery photo:</span>
                                                        <img src={resolveDocumentUrl(del.deliveryPhotoUrl)} className="w-20 h-10 object-cover rounded-control border hover:scale-105 transition-all cursor-zoom-in" alt="Delivery Evidence" />
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
        className={`bg-surface rounded-card border shadow-card overflow-hidden flex flex-col transition-all duration-300 ${isOverUnassignedDropZone
            ? 'border-brand ring-4 ring-brand/10 bg-brand/[0.04]'
            : 'border-line'
          }`}
      >
        <div className="bg-ink/[0.03] px-6 py-4 border-b border-line flex justify-between items-center select-none">
          <div>
            <h3 className="text-sm font-bold text-ink flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-ochre animate-pulse"></span>
              Unassigned Orders Pool
              {!awaitingDateChoice && (
                <span className="font-semibold text-muted">— {poolDateLabel}</span>
              )}
            </h3>
          </div>
          {isOverUnassignedDropZone && (
            <motion.div
              initial={{ scale: 0.9 }}
              animate={{ scale: 1 }}
              className="text-[12.5px] font-bold text-brand bg-brand/10 px-3 py-1 rounded-control animate-bounce"
            >
              Drop here to Unassign!
            </motion.div>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-line">
            <thead className="bg-ink/[0.03]">
              <tr>
                <th scope="col" className="px-6 py-3 text-left text-[12.5px] font-bold text-muted select-none">Order</th>
                <th scope="col" className="px-6 py-3 text-left text-[12.5px] font-bold text-muted select-none">Customer</th>
                <th scope="col" className="px-6 py-3 text-left text-[12.5px] font-bold text-muted select-none">Product</th>
                <th scope="col" className="px-6 py-3 text-left text-[12.5px] font-bold text-muted select-none">Quantity</th>
                <th scope="col" className="px-6 py-3 text-left text-[12.5px] font-bold text-muted select-none">Date</th>
                <th scope="col" className="px-6 py-3 text-left text-[12.5px] font-bold text-muted select-none">Status</th>
                <th scope="col" className="px-6 py-3 text-right text-[12.5px] font-bold text-muted select-none">Assign</th>
              </tr>
            </thead>
            <tbody className="bg-surface divide-y divide-line">
              {loading && board.unassignedOrders.length === 0 ? (
                <UnassignedTableSkeleton />
              ) : filteredUnassignedOrders.length === 0 ? (
                <tr>
                  <td colSpan="7" className="px-6 py-12 text-center text-muted select-none">
                    <EmptyState
                      icon={Package2}
                      title={awaitingDateChoice ? 'Pick a date' : `Nothing waiting for ${poolDateLabel}`}
                      message={
                        awaitingDateChoice
                          ? 'Choose a date above to see the orders imported that day.'
                          : 'Every order from this day is assigned, or none match this search.'
                      }
                    />
                  </td>
                </tr>
              ) : (
                filteredUnassignedOrders.map(order => (
                  <tr
                    key={order.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, order.id, null)}
                    onDragEnd={handleDragEnd}
                    className={`hover:bg-brand/[0.04] transition-colors cursor-grab active:cursor-grabbing group relative ${draggingOrderId === order.id ? 'opacity-40 bg-ink/[0.03]' : ''
                      }`}
                  >
                    {/* Order Column */}
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center gap-3">
                        <div className="p-2 bg-ink/[0.06] rounded-control group-hover:bg-brand/10 transition-colors flex-shrink-0">
                          <Package2 className="w-5 h-5 text-muted group-hover:text-brand" />
                        </div>
                        <div className="text-sm font-bold text-ink flex items-center gap-1.5 select-none">
                          <GripVertical size={14} className="text-muted group-hover:text-muted transition-colors flex-shrink-0" />
                          {order.spruceOrderId}
                        </div>
                      </div>
                    </td>

                    {/* Customer Column */}
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-muted font-medium select-none">
                      {order.customerName}
                    </td>

                    {/* Product Column */}
                    <td className="px-6 py-4 whitespace-nowrap">
                      <Badge tone="neutral">{order.product}</Badge>
                    </td>

                    {/* Quantity Column */}
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-muted font-bold select-none">
                      {formatQuantity(order.quantity, order.unit)}
                    </td>

                    {/* Date Column */}
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-muted select-none">
                      {formatDate(order.createdAt)}
                    </td>

                    {/* Status Column */}
                    <td className="px-6 py-4 whitespace-nowrap">
                      <Badge tone="warn">Waiting</Badge>
                    </td>

                    {/* Assign Column */}
                    <td className="px-6 py-4 whitespace-nowrap text-right">
                      <select
                        className="border border-line rounded-control px-2 py-1 text-[12.5px] font-bold bg-surface focus:ring-1 focus:ring-brand outline-none cursor-pointer text-muted hover:border-brand/40 transition-all"
                        onChange={(e) => {
                          if (e.target.value) {
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
                          <option key={d.id} value={d.id}>
                            {d.name} {d.type === 'INDEPENDENT' && d.companyName ? `(${d.companyName})` : ''}
                          </option>
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
