import React, { useState, useEffect, useCallback } from 'react';
import { useSelector } from 'react-redux';
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
import { assignWarning, deliveryTypeLabel, flagBadges, mergeUnassignedOrders, orderRef } from '../../lib/dispatchBoard';
import { canCorrectHistory, formatDeliveryDay, isPastDay, returnsTo, upcomingSummary } from '../../lib/dispatchDays';
import OrderEditor from '../../components/orders/OrderEditor';

/** The undated list shows this many at most; a search finds the rest. */
const UNDATED_LIMIT = 100;

/**
 * Who the order is for and where it goes, under the customer's name. A whole
 * Spruce order carries both; a stop made before orders were dispatched whole
 * carries neither, and shows only the name as before.
 */
function OrderDestination({ order }) {
  if (!order?.wholeOrder) return null;
  return (
    <div className="mt-1 space-y-0.5 text-[12.5px] font-normal whitespace-normal">
      <p className={order.address ? 'text-muted' : 'text-clay font-semibold'}>
        {order.address || 'No address'}
      </p>
      {order.phone && <p className="text-muted tabular">{order.phone}</p>}
    </div>
  );
}

/** What goes on the truck and how, beside the product summary. */
function OrderLoad({ order }) {
  const type = deliveryTypeLabel(order?.deliveryType);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge tone="neutral">{order.product}</Badge>
      {type && <Badge tone="good">{type}</Badge>}
      {order?.skids > 0 && (
        <span className="text-[12.5px] text-muted font-semibold">
          {order.skids} skid{order.skids === 1 ? '' : 's'}
        </span>
      )}
    </div>
  );
}

function OrderFlags({ order }) {
  const badges = flagBadges(order);
  if (badges.length === 0 && !order?.edited) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mt-1.5">
      {order?.edited && <Badge tone="neutral">Edited</Badge>}
      {badges.map(({ flag, label, tone }) => <Badge key={flag} tone={tone}>{label}</Badge>)}
    </div>
  );
}

/**
 * Opens the editor for a whole order; stops made before have nothing to edit.
 * On a past day it opens the same view, read-only.
 */
function EditButton({ order, onEdit, readOnly = false }) {
  if (!order?.wholeOrder) return null;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onEdit(order.id); }}
      className="px-2.5 py-1.5 rounded-control border border-line text-ink hover:bg-brand/10 text-[12.5px] font-bold transition-colors bg-surface"
    >
      {readOnly ? 'View' : 'Edit'}
    </button>
  );
}

/** The header row every section of the board shares. */
function SectionHeader({ dot, title, detail, children }) {
  return (
    <div className="bg-ink/[0.03] px-6 py-4 border-b border-line flex flex-wrap gap-3 justify-between items-center select-none">
      <h3 className="text-sm font-bold text-ink flex items-center gap-2">
        <span className={cn('w-2 h-2 rounded-full', dot)}></span>
        {title}
        {detail && <span className="font-semibold text-muted">— {detail}</span>}
      </h3>
      {children}
    </div>
  );
}

export default function DispatchBoard() {
  const role = useSelector((state) => state.auth?.user?.role);
  const [board, setBoard] = useState({ carriedOver: [], unassignedOrders: [], unassignedDeliveries: [], drivers: [] });
  // Days after today with orders due, and orders with no date at all.
  const [upcoming, setUpcoming] = useState([]);
  const [undated, setUndated] = useState({ orders: [], loading: true });
  const [undatedSearch, setUndatedSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [expandedDriverId, setExpandedDriverId] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  // The order open in the editor, by id, and whether it opened from a past day.
  const [editingOrderId, setEditingOrderId] = useState(null);
  const [editingReadOnly, setEditingReadOnly] = useState(false);

  const [draggingOrderId, setDraggingOrderId] = useState(null);
  const [draggingFromDriverId, setDraggingFromDriverId] = useState(null);
  const [activeDragTargetDriverId, setActiveDragTargetDriverId] = useState(null);
  const [isOverUnassignedDropZone, setIsOverUnassignedDropZone] = useState(false);

  // The pool is the orders due out on the chosen day, today by default.
  const [dateFilter, setDateFilter] = useState('today'); // 'today' | 'yesterday' | 'select'
  const [selectedDate, setSelectedDate] = useState(''); // 'YYYY-MM-DD'

  const today = businessDayOffset(0);
  const poolDate =
    dateFilter === 'today' ? today
    : dateFilter === 'yesterday' ? businessDayOffset(-1)
    : selectedDate;

  const awaitingDateChoice = dateFilter === 'select' && !selectedDate;
  // Yesterday and older are history: nothing on them is handed out or taken
  // back. The server refuses the finished ones whatever this screen shows.
  const readOnly = !awaitingDateChoice && isPastDay(poolDate, today);
  // Admins may still correct a stop's status there.
  const canChangeStatus = !readOnly || canCorrectHistory(role);
  const isTodayBoard = !awaitingDateChoice && poolDate === today;

  const openEditor = (orderId, viewOnly = readOnly) => {
    setEditingReadOnly(viewOnly);
    setEditingOrderId(orderId);
  };

  const fetchUpcoming = useCallback(() => {
    api.get('/api/dispatch/upcoming')
      .then(({ data }) => setUpcoming(Array.isArray(data) ? data : []))
      .catch((e) => console.error(e));
  }, []);

  const fetchUndated = useCallback(async (search = '') => {
    try {
      const { data } = await api.get('/api/dispatch/pickups', { params: search ? { search } : {} });
      setUndated({ orders: Array.isArray(data) ? data : [], loading: false });
    } catch (e) {
      console.error(e);
      setUndated((current) => ({ ...current, loading: false }));
    }
  }, []);

  // The undated list follows its own search box, a moment after typing stops.
  useEffect(() => {
    const timer = setTimeout(() => fetchUndated(undatedSearch.trim()), 250);
    return () => clearTimeout(timer);
  }, [fetchUndated, undatedSearch]);

  const showDay = (day) => {
    setSelectedDate(day);
    setDateFilter(day === today ? 'today' : 'select');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

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
        carriedOver: data?.carriedOver || [],
        unassignedOrders: mergeUnassignedOrders(
          data?.unassignedOrders,
          data?.unassignedDeliveries,
        ),
        drivers,
      });
      // Assigning ahead changes what is left to assign on those days.
      fetchUpcoming();
    } catch (e) {
      console.error(e);
      if (!isBackgroundSync) toast.error('Failed to fetch dispatch board');
    } finally {
      setLoading(false);
    }
  }, [awaitingDateChoice, poolDate, fetchUpcoming]);

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

  // An open row whose last order has just been unassigned has nothing left to
  // show, so it closes itself rather than sitting open and empty.
  useEffect(() => {
    if (!expandedDriverId) return;
    const expanded = board.drivers.find(d => d.id === expandedDriverId);
    if (expanded && expanded.deliveries.length === 0) {
      setExpandedDriverId(null);
    }
  }, [board, expandedDriverId]);

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
    if (readOnly) {
      e.preventDefault();
      return;
    }
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
    if (readOnly) return;
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
    if (!orderId || readOnly) return;

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

    // Asked once, when the order first leaves the pool; moving it between
    // drivers afterwards is the dispatcher's own rearranging.
    const warning = !draggingFromDriverId ? assignWarning(orderObj) : null;
    if (warning && !window.confirm(warning)) {
      handleDragEnd();
      return;
    }

    // The optimistic row needs an id before the server has given it one, and
    // the same id afterwards to find the row again and swap the real one in.
    const optimisticDeliveryId = `temp-${Date.now()}`;

    try {
      // Optimistic updates
      setExpandedDriverId(targetDriverId);
      setBoard(prev => {
        let updatedUnassigned = [...prev.unassignedOrders];
        let updatedCarriedOver = prev.carriedOver;
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
                id: optimisticDeliveryId,
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
          updatedCarriedOver = updatedCarriedOver.filter(o => o.id !== orderId);
        }

        return {
          ...prev,
          carriedOver: updatedCarriedOver,
          unassignedOrders: updatedUnassigned,
          drivers: updatedDrivers
        };
      });

      const { data: created } = await api.post('/api/dispatch/assign', {
        ...orderRef(orderObj),
        driverId: targetDriverId,
      });

      // Without this the row keeps its `temp-...` id until something else
      // refetches the board, and the status dropdown next to it sends that id
      // to /api/deliveries/:id/status. The column is a uuid, so Postgres threw
      // on the way in and the clerk got a raw Prisma error for picking "Out
      // for delivery" on an order they had just dragged across.
      if (created?.id) {
        setBoard(prev => ({
          ...prev,
          drivers: prev.drivers.map(d => d.id !== targetDriverId ? d : {
            ...d,
            deliveries: d.deliveries
              .map(del => del.id !== optimisticDeliveryId ? del : {
                ...del,
                id: created.id,
                status: created.status ?? del.status,
                priority: created.priority ?? del.priority,
              })
              .sort((a, b) => (a.priority || 0) - (b.priority || 0)),
          }),
        }));
      } else {
        // No record came back, so nothing on screen can be trusted to match.
        fetchBoard();
      }

      toast.success(`Assigned ${orderObj.spruceOrderId} to ${driverObj.name}`);
    } catch (err) {
      console.error(err);
      // "Already delivered", "someone else just dispatched it": the server says why.
      toast.error(err.response?.data?.error || 'Failed to assign driver');
      fetchBoard();
    } finally {
      handleDragEnd();
    }
  };

  const handleDropOnDelivery = async (e, targetDriverId, targetOrderId) => {
    e.preventDefault();
    e.stopPropagation(); // prevent driver drop handler from catching this
    const orderId = draggingOrderId || e.dataTransfer.getData('text/plain');
    if (!orderId || readOnly) return;

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
    if (!orderId || !draggingFromDriverId || readOnly) {
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

        // An order due before today goes back to Carried over, not to
        // today's pool; one due on another day leaves this board.
        const destination = returnsTo(orderObj, poolDate, today);
        const putBack = (list) => (list.some(o => o.id === orderId) ? list : [orderObj, ...list]);

        return {
          ...prev,
          carriedOver: destination === 'carriedOver' ? putBack(prev.carriedOver) : prev.carriedOver,
          unassignedOrders: destination === 'pool' ? putBack(prev.unassignedOrders) : prev.unassignedOrders,
          drivers: updatedDrivers
        };
      });

      await api.post('/api/dispatch/unassign', orderRef(orderObj));
      toast.success(`Unassigned order ${orderObj.spruceOrderId}`);
    } catch (err) {
      console.error(err);
      toast.error(err.response?.data?.error || 'Failed to unassign order');
      fetchBoard();
    } finally {
      handleDragEnd();
    }
  };

  const findOrder = (orderId) => {
    const fromUnassigned = board.unassignedOrders.find(o => o.id === orderId)
      ?? board.carriedOver.find(o => o.id === orderId);
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
  const filteredCarriedOver = isTodayBoard ? filterOrders(board.carriedOver) : [];

  /** Hands a waiting order to the driver picked from its Quick Assign menu. */
  const quickAssign = (order, driverId) => {
    const driverObj = board.drivers.find(d => d.id === driverId);
    const warning = assignWarning(order);
    if (driverObj && (!warning || window.confirm(warning))) {
      api.post('/api/dispatch/assign', { ...orderRef(order), driverId: driverObj.id })
        .then(() => {
          toast.success(`Assigned ${order.spruceOrderId} to ${driverObj.name}`);
          fetchBoard();
        })
        .catch((err) => {
          toast.error(err.response?.data?.error || 'Failed to assign driver');
          fetchBoard();
        });
    }
  };

  /**
   * One waiting order. The pool and Carried over draw the same row; a carried
   * over one shows the day it was due in place of today's.
   */
  const waitingRow = (order, { carried = false } = {}) => (
    <tr
      key={order.id}
      draggable={!readOnly}
      onDragStart={(e) => handleDragStart(e, order.id, null)}
      onDragEnd={handleDragEnd}
      className={cn(
        'hover:bg-brand/[0.04] transition-colors group relative',
        !readOnly && 'cursor-grab active:cursor-grabbing',
        draggingOrderId === order.id && 'opacity-40 bg-ink/[0.03]'
      )}
    >
      {/* Order Column */}
      <td className="px-6 py-4 whitespace-nowrap">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-ink/[0.06] rounded-control group-hover:bg-brand/10 transition-colors flex-shrink-0">
            <Package2 className="w-5 h-5 text-muted group-hover:text-brand" />
          </div>
          <div className="text-sm font-bold text-ink flex items-center gap-1.5 select-none">
            {!readOnly && <GripVertical size={14} className="text-muted group-hover:text-muted transition-colors flex-shrink-0" />}
            {order.spruceOrderId}
          </div>
        </div>
      </td>

      {/* Customer Column */}
      <td className="px-6 py-4 whitespace-nowrap text-sm text-muted font-medium select-none">
        {order.customerName}
        <OrderDestination order={order} />
      </td>

      {/* Product Column */}
      <td className="px-6 py-4 whitespace-nowrap">
        <OrderLoad order={order} />
      </td>

      {/* Quantity Column */}
      <td className="px-6 py-4 whitespace-nowrap text-sm text-muted font-bold select-none">
        {formatQuantity(order.quantity, order.unit)}
      </td>

      {/* Date Column */}
      <td className={cn('px-6 py-4 whitespace-nowrap text-sm select-none', carried ? 'text-clay font-semibold' : 'text-muted')}>
        {order.deliveryDate ? formatDeliveryDay(order.deliveryDate) : formatDate(order.createdAt)}
      </td>

      {/* Status Column */}
      <td className="px-6 py-4 whitespace-nowrap">
        <Badge tone={carried ? 'bad' : 'warn'}>{carried ? 'Not delivered' : 'Waiting'}</Badge>
        <OrderFlags order={order} />
      </td>

      {/* Assign Column */}
      <td className="px-6 py-4 whitespace-nowrap text-right">
        <div className="flex items-center justify-end gap-2">
          <EditButton order={order} onEdit={openEditor} readOnly={readOnly} />
          {!readOnly && (
            <select
              className="border border-line rounded-control px-2 py-1 text-[12.5px] font-bold bg-surface focus:ring-1 focus:ring-brand outline-none cursor-pointer text-muted hover:border-brand/40 transition-all"
              aria-label={`Quick assign ${order.spruceOrderId}`}
              onChange={(e) => {
                if (e.target.value) quickAssign(order, e.target.value);
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
          )}
        </div>
      </td>
    </tr>
  );

  const waitingTableHead = (
    <thead className="bg-ink/[0.03]">
      <tr>
        <th scope="col" className="px-6 py-3 text-left text-[12.5px] font-bold text-muted select-none">Order</th>
        <th scope="col" className="px-6 py-3 text-left text-[12.5px] font-bold text-muted select-none">Customer</th>
        <th scope="col" className="px-6 py-3 text-left text-[12.5px] font-bold text-muted select-none">Product</th>
        <th scope="col" className="px-6 py-3 text-left text-[12.5px] font-bold text-muted select-none">Quantity</th>
        <th scope="col" className="px-6 py-3 text-left text-[12.5px] font-bold text-muted select-none">Delivery</th>
        <th scope="col" className="px-6 py-3 text-left text-[12.5px] font-bold text-muted select-none">Status</th>
        <th scope="col" className="px-6 py-3 text-right text-[12.5px] font-bold text-muted select-none">{readOnly ? 'Details' : 'Assign'}</th>
      </tr>
    </thead>
  );

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

      {readOnly && (
        <div className="bg-surface rounded-card border border-line shadow-card px-6 py-3 flex items-start gap-2 text-[13px] text-muted">
          <Info size={16} className="text-ochre flex-shrink-0 mt-0.5" />
          <p>
            <span className="font-semibold text-ink">{poolDateLabel.charAt(0).toUpperCase() + poolDateLabel.slice(1)} is history, so this board is read-only.</span>{' '}
            Orders from this day that never went out are under Carried over on today&apos;s board.
            {canCorrectHistory(role) && ' As an admin you can still correct a stop’s status.'}
          </p>
        </div>
      )}

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
                                {readOnly ? 'No assignments this day' : 'No assignments — drag orders onto this row to assign'}
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
                              // Closing always works. Guarding the whole toggle
                              // on there being something to show left the row
                              // stuck open once the driver's last order was
                              // unassigned, answering the click to close it
                              // with an error toast.
                              if (isExpanded) {
                                setExpandedDriverId(null);
                              } else if (filteredDeliveries.length > 0) {
                                setExpandedDriverId(driver.id);
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
                                      {readOnly ? 'History — read-only' : 'Drag any order row down to the pool to unassign'}
                                    </span>
                                  </div>

                                  {/* List of Orders in 100% full-screen width table format */}
                                  <table className="min-w-full divide-y divide-line">
                                    <tbody className="divide-y divide-line bg-surface">
                                      {filteredDeliveries.map((del) => {
                                        return (
                                          <React.Fragment key={del.id}>
                                            <tr
                                              draggable={!readOnly}
                                              onDragStart={(e) => {
                                                handleDragStart(e, del.order.id, driver.id);
                                              }}
                                              onDragOver={(e) => { if (!readOnly) e.preventDefault(); }}
                                              onDrop={(e) => handleDropOnDelivery(e, driver.id, del.order.id)}
                                              onDragEnd={handleDragEnd}
                                              className={`hover:bg-brand/[0.04] transition-colors ${readOnly ? '' : 'cursor-grab active:cursor-grabbing'} group/item relative ${draggingOrderId === del.order.id ? 'opacity-40 bg-ink/[0.03]' : ''
                                                }`}
                                            >
                                              {/* Order ID Column */}
                                              <td className="px-6 py-4 whitespace-nowrap w-48">
                                                <div className="flex items-center gap-2">
                                                  <div className="p-1.5 bg-ink/[0.06] rounded-control text-muted group-hover/item:text-brand group-hover/item:bg-brand/10 transition-colors flex-shrink-0">
                                                    <Package2 className="w-4 h-4" />
                                                  </div>
                                                  <div className="text-[12.5px] font-bold text-ink flex items-center gap-1.5 select-none">
                                                    {!readOnly && <GripVertical size={12} className="text-muted group-hover/item:text-muted transition-colors flex-shrink-0" />}
                                                    {del.order.spruceOrderId}
                                                  </div>
                                                </div>
                                              </td>

                                              {/* Customer Column */}
                                              <td className="px-6 py-4 whitespace-nowrap text-[12.5px] text-muted font-bold select-none w-64">
                                                {del.order.customerName}
                                                <OrderDestination order={del.order} />
                                              </td>

                                              {/* Product Column */}
                                              <td className="px-6 py-4 whitespace-nowrap w-40">
                                                <OrderLoad order={del.order} />
                                                <OrderFlags order={del.order} />
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
                                                      state, that state listed first.
                                                      On a past day, admins only. */}
                                                  {canChangeStatus && (
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
                                                  )}


                                                  <EditButton order={del.order} onEdit={openEditor} readOnly={readOnly} />
                                                  {!readOnly && (
                                                  <button
                                                    onClick={(e) => {
                                                      e.stopPropagation();
                                                      api.post('/api/dispatch/unassign', orderRef(del.order))
                                                        .then(() => {
                                                          toast.success('Unassigned order');
                                                          fetchBoard();
                                                        })
                                                        .catch((err) => {
                                                          toast.error(err.response?.data?.error || 'Failed to unassign order');
                                                          fetchBoard();
                                                        });
                                                    }}
                                                    className="px-2.5 py-1.5 rounded-control border border-clay/30 text-clay hover:bg-clay/10 text-[12.5px] font-bold transition-colors bg-surface"
                                                    title="Remove Assignment"
                                                  >
                                                    Unassign
                                                  </button>
                                                  )}
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
                                                        <img src={del.pickupPhotoUrl} className="w-20 h-10 object-cover rounded-control border hover:scale-105 transition-all cursor-zoom-in" alt="Pickup Evidence" />
                                                      </div>
                                                    )}
                                                    {del.deliveryPhotoUrl && (
                                                      <div className="flex gap-2 items-center">
                                                        <span className="text-[12.5px] font-bold text-muted">Delivery photo:</span>
                                                        <img src={del.deliveryPhotoUrl} className="w-20 h-10 object-cover rounded-control border hover:scale-105 transition-all cursor-zoom-in" alt="Delivery Evidence" />
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

      {/* Earlier orders that never went out, on today's board only. Orders
          still on a driver's run are under that driver instead. */}
      {isTodayBoard && board.carriedOver.length > 0 && (
        <div className="bg-surface rounded-card border border-line shadow-card overflow-hidden flex flex-col">
          <SectionHeader dot="bg-clay" title="Carried over" detail="due on an earlier day and not delivered">
            <span className="text-[12.5px] text-muted font-semibold">
              Assign them like the pool, or use Edit to move the date
            </span>
          </SectionHeader>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-line">
              {waitingTableHead}
              <tbody className="bg-surface divide-y divide-line">
                {filteredCarriedOver.length === 0 ? (
                  <tr>
                    <td colSpan="7" className="px-6 py-6 text-center text-[13px] text-muted select-none">
                      None match this search.
                    </td>
                  </tr>
                ) : (
                  filteredCarriedOver.map(order => waitingRow(order, { carried: true }))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

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
            {waitingTableHead}
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
                          ? 'Choose a date above to see the orders due out that day.'
                          : 'Every order due out this day is assigned, or none match this search.'
                      }
                    />
                  </td>
                </tr>
              ) : (
                filteredUnassignedOrders.map(order => waitingRow(order))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Days ahead with orders due. Opening one shows its board, where its
          orders can be assigned ahead like any other day's. */}
      <div className="bg-surface rounded-card border border-line shadow-card overflow-hidden flex flex-col">
        <SectionHeader dot="bg-brand" title="Upcoming" detail="orders due after today" />
        <div className="px-6 py-4">
          {upcoming.length === 0 ? (
            <p className="text-[13px] text-muted">Nothing is booked after today.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {upcoming.map(day => (
                <Button
                  key={day.date}
                  size="sm"
                  onClick={() => showDay(day.date)}
                  aria-pressed={poolDate === day.date}
                  className={cn(poolDate === day.date && 'border-brand/40 bg-brand/[0.06]')}
                  title={`Open the board for ${formatDeliveryDay(day.date, { dateStyle: 'full' })}`}
                >
                  <Calendar size={14} className="text-muted" />
                  <span className="tabular">{formatDeliveryDay(day.date, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
                  <span className="font-medium text-muted">{upcomingSummary(day)}</span>
                </Button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Orders with no delivery date never reach a day's board. */}
      <div className="bg-surface rounded-card border border-line shadow-card overflow-hidden flex flex-col">
        <SectionHeader dot="bg-muted" title="Pickups and orders with no date" detail="never on the board">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
            <Input
              type="text"
              placeholder="Search order # or customer..."
              aria-label="Search pickups and orders with no date"
              className="pl-10 w-64"
              value={undatedSearch}
              onChange={(e) => setUndatedSearch(e.target.value)}
            />
          </div>
        </SectionHeader>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-line">
            <thead className="bg-ink/[0.03]">
              <tr>
                <th scope="col" className="px-6 py-3 text-left text-[12.5px] font-bold text-muted select-none">Order</th>
                <th scope="col" className="px-6 py-3 text-left text-[12.5px] font-bold text-muted select-none">Customer</th>
                <th scope="col" className="px-6 py-3 text-left text-[12.5px] font-bold text-muted select-none">Product</th>
                <th scope="col" className="px-6 py-3 text-left text-[12.5px] font-bold text-muted select-none">Quantity</th>
                <th scope="col" className="px-6 py-3 text-left text-[12.5px] font-bold text-muted select-none">Type</th>
                <th scope="col" className="px-6 py-3 text-right text-[12.5px] font-bold text-muted select-none">Details</th>
              </tr>
            </thead>
            <tbody className="bg-surface divide-y divide-line">
              {undated.orders.length === 0 ? (
                <tr>
                  <td colSpan="6" className="px-6 py-6 text-center text-[13px] text-muted select-none">
                    {undated.loading
                      ? 'Loading…'
                      : undatedSearch.trim()
                        ? 'No pickup or undated order matches this search.'
                        : 'No pickups, and every order has a date.'}
                  </td>
                </tr>
              ) : (
                undated.orders.map(order => (
                  <tr key={order.id} className="hover:bg-brand/[0.04] transition-colors group">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center gap-3">
                        <div className="p-2 bg-ink/[0.06] rounded-control group-hover:bg-brand/10 transition-colors flex-shrink-0">
                          <Package2 className="w-5 h-5 text-muted group-hover:text-brand" />
                        </div>
                        <div className="text-sm font-bold text-ink select-none">{order.spruceOrderId}</div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-muted font-medium select-none">
                      {order.customerName}
                      {/* A pickup goes nowhere; an undated delivery shows where it is bound. */}
                      {!order.isPickup && <OrderDestination order={order} />}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <OrderLoad order={order} />
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-muted font-bold select-none">
                      {formatQuantity(order.quantity, order.unit)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <Badge tone={order.isPickup ? 'neutral' : 'warn'}>{order.isPickup ? 'Pickup' : 'Delivery, no date yet'}</Badge>
                      <OrderFlags order={order} />
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right">
                      <EditButton order={order} onEdit={(id) => openEditor(id, false)} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {undated.orders.length >= UNDATED_LIMIT && (
          <p className="px-6 py-3 border-t border-line text-[12.5px] text-muted">
            Showing the newest {UNDATED_LIMIT}. Search to find an older one.
          </p>
        )}
      </div>

      {editingOrderId && (
        <OrderEditor
          orderRef={editingOrderId}
          readOnly={editingReadOnly}
          onClose={() => setEditingOrderId(null)}
          // A corrected date moves the order off this day, or onto a day from
          // the undated list; a filled address clears its flag. Either way the
          // board and its lists are redrawn from the server.
          onSaved={() => {
            fetchBoard(true);
            fetchUndated(undatedSearch.trim());
          }}
        />
      )}
    </div>
  );
}
