import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api/axios';
import { Search, Calendar, ChevronDown, ChevronUp, User, Image as ImageIcon, X } from 'lucide-react';
import { DeliveryTableSkeleton } from '../../components/Skeleton';
import { FadeInUp } from '../../components/Animated';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'react-hot-toast';
import { Badge, Card, EmptyState, Input, PageHeader, Select, StatusBadge } from '../../components/ui';
import StatusTimeline from '../../components/deliveries/StatusTimeline';
import { cn } from '../../lib/cn';
import { formatDate } from '../../lib/date';
import { isTerminal, statusErrorMessage, statusOptionsFor } from '../../lib/deliveryTransitions';

export default function DeliveriesPage() {
  const [searchParams] = useSearchParams();
  const [deliveries, setDeliveries] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedDeliveryId, setExpandedDeliveryId] = useState(null);

  // Search and Filter State
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDate, setSelectedDate] = useState('');
  const [selectedDriver, setSelectedDriver] = useState('');

  const driverIdParam = searchParams.get('driverId');

  /**
   * Reads from the Express API rather than the `fetch-cgc-data` Edge function.
   *
   * The Edge hop is an extra network round trip into something that can be cold,
   * which is part of why this page was slow to open.
   *
   * It is only part of it. `GET /api/deliveries` is still unbounded — a
   * `findMany` with no `take`, returning every delivery ever recorded with its
   * full order, that order's supplier and tickets, and the delivery's complete
   * status history — and this page then filters the lot in the browser. Making
   * that query paginated and day-scoped, the way invoices and tickets already
   * are, is a separate piece of work. Until then this page is faster to open but
   * still grows with the table.
   */
  const fetchData = useCallback(async () => {
    try {
      setLoading(true);

      const [delRes, driverRes] = await Promise.all([
        api.get('/api/deliveries'),
        api.get('/api/drivers'),
      ]);

      setDeliveries(Array.isArray(delRes.data) ? delRes.data : delRes.data?.data || []);
      setDrivers(Array.isArray(driverRes.data) ? driverRes.data : driverRes.data?.data || []);
    } catch (e) {
      console.error('Failed to fetch data', e);
      toast.error('Failed to load deliveries');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (driverIdParam) {
      setSelectedDriver(driverIdParam);
    }
  }, [driverIdParam]);

  const handleStatusUpdate = async (deliveryId, newStatus) => {
    // Optimistic Update including instant Update History entry
    const originalDeliveries = [...deliveries];
    const now = new Date();

    setDeliveries(prev => prev.map(del => {
      if (del.id === deliveryId) {
        const newHistoryItem = {
          id: 'temp-' + Date.now(),
          deliveryId,
          status: newStatus,
          notes: `Status updated to ${newStatus}`,
          createdAt: now.toISOString()
        };
        return {
          ...del,
          status: newStatus,
          startedAt: newStatus === 'IN_TRANSIT' && !del.startedAt ? now.toISOString() : del.startedAt,
          completedAt: newStatus === 'DELIVERED' ? now.toISOString() : del.completedAt,
          history: [newHistoryItem, ...(del.history || [])]
        };
      }
      return del;
    }));

    try {
      const res = await api.patch(`/api/deliveries/${deliveryId}/status`, { status: newStatus });
      toast.success(`Status updated to ${newStatus}`);
      if (res.data) {
        setDeliveries(prev => prev.map(del => del.id === deliveryId ? { ...del, ...res.data } : del));
      }
    } catch (e) {
      console.error(e);
      // The server explains precisely why it refused — an illegal transition, a
      // terminal state, a missing delivery photo. Replacing that with "Failed to
      // update status" left operators with nothing to act on.
      toast.error(statusErrorMessage(e));
      setDeliveries(originalDeliveries);
    }
  };

  const filteredDeliveries = useMemo(() => {
    let result = [...deliveries];

    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(del =>
        del.order?.spruceOrderId?.toLowerCase().includes(query) ||
        del.order?.customerName?.toLowerCase().includes(query) ||
        del.driver?.name?.toLowerCase().includes(query) ||
        del.order?.product?.toLowerCase().includes(query)
      );
    }

    // Date filter
    if (selectedDate) {
      result = result.filter(del => {
        const delDate = new Date(del.createdAt).toISOString().split('T')[0];
        return delDate === selectedDate;
      });
    }

    // Driver filter
    if (selectedDriver) {
      result = result.filter(del => del.driverId === selectedDriver);
    }

    // Sort by date descending
    return result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }, [deliveries, searchQuery, selectedDate, selectedDriver]);

  if (loading) return <DeliveryTableSkeleton />;

  return (
    <div className="space-y-6 max-w-6xl mx-auto pb-20">
      <FadeInUp>
        <PageHeader
          title="Deliveries"
          subtitle="What went out, who took it, and the photos that prove it."
        />
      </FadeInUp>

      <div className="space-y-4">
        <FadeInUp>
          <Card className="p-4 space-y-4">
            <div className="flex flex-col md:flex-row gap-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" size={18} />
                <Input
                  type="text"
                  placeholder="Search by order ID, customer, or driver..."
                  className="pl-10 pr-10"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-ink"
                  >
                    <X size={16} />
                  </button>
                )}
              </div>

              <div className="flex flex-wrap gap-3">
                <div className="relative min-w-[160px]">
                  <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" size={16} />
                  <Input
                    type="date"
                    className="pl-10 tabular"
                    value={selectedDate}
                    onChange={(e) => setSelectedDate(e.target.value)}
                  />
                </div>

                <div className="relative min-w-[160px]">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" size={16} />
                  <Select
                    className="pl-10"
                    value={selectedDriver}
                    onChange={(e) => setSelectedDriver(e.target.value)}
                  >
                    <option value="">All drivers</option>
                    {drivers.map(d => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </Select>
                </div>

                {(searchQuery || selectedDate || selectedDriver) && (
                  <button
                    onClick={() => {
                      setSearchQuery('');
                      setSelectedDate('');
                      setSelectedDriver('');
                    }}
                    className="flex items-center gap-2 text-[12.5px] font-semibold text-clay px-3 hover:bg-clay/10 rounded-control transition-colors"
                  >
                    <X size={14} /> Clear
                  </button>
                )}
              </div>
            </div>
          </Card>
        </FadeInUp>

        {filteredDeliveries.length === 0 ? (
          <EmptyState
            title={deliveries.length === 0 ? 'No deliveries yet' : 'No deliveries match'}
            message={deliveries.length === 0 ? 'Deliveries appear here once dispatch assigns an order to a driver.' : 'Try another search, date, or driver.'}
          />
        ) : (
          filteredDeliveries.map((del, idx) => {
            const isDelExpanded = expandedDeliveryId === del.id;
            return (
              <div
                key={del.id}
                className={cn(
                  'bg-surface rounded-card border transition-all duration-300',
                  isDelExpanded ? 'border-ochre/40 shadow-lift' : 'border-line shadow-card hover:border-brand/30'
                )}
              >
                <div className="px-6 py-5 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-5 flex-1">
                    <div className="w-10 h-10 rounded-control bg-ink/[0.06] flex items-center justify-center text-[13px] font-bold text-muted tabular">
                      {idx + 1}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="font-bold text-ink text-lg leading-none">{del.order.spruceOrderId}</h4>
                        <Badge tone="neutral">{del.order.product}</Badge>
                      </div>
                      <div className="flex items-center gap-2 mt-2">
                        <p className="text-[13px] text-muted font-medium truncate max-w-[200px]">{del.order.customerName}</p>
                        <span className="text-muted">·</span>
                        <span className="text-[13px] text-brand font-semibold flex items-center gap-1">
                          <User size={12} /> {del.driver?.name || 'Unassigned'}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="hidden md:block flex-1">
                    <p className="text-[12.5px] font-medium text-muted leading-none mb-1">Scheduled</p>
                    <div className="flex items-center gap-1.5 text-ink font-semibold text-sm tabular">
                      <Calendar size={14} className="text-muted" />
                      {formatDate(del.createdAt)}
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <StatusBadge status={del.status} />
                    <div className="flex items-center gap-2">
                      {/* Only the moves the server will actually accept from
                          this delivery's current state, with that state listed
                          first so the control never misreports it. */}
                      <Select
                        className="h-9 text-[13px] w-auto"
                        value={del.status}
                        disabled={isTerminal(del.status)}
                        title={
                          isTerminal(del.status)
                            ? `${del.status} is final and cannot be changed here`
                            : 'Change delivery status'
                        }
                        onChange={(e) => handleStatusUpdate(del.id, e.target.value)}
                      >
                        {statusOptionsFor(del).map(option => (
                          <option key={option.value} value={option.value} disabled={option.disabled}>
                            {option.label}
                          </option>
                        ))}
                      </Select>
                      <button
                        onClick={() => setExpandedDeliveryId(isDelExpanded ? null : del.id)}
                        className={cn(
                          'p-2 rounded-control transition-colors',
                          isDelExpanded ? 'bg-ochre/20 text-ochre' : 'bg-ink/[0.04] text-muted hover:bg-ink/[0.08]'
                        )}
                      >
                        {isDelExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                      </button>
                    </div>
                  </div>
                </div>

                <AnimatePresence>
                  {isDelExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden border-t border-line"
                    >
                      <div className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-8 bg-ink/[0.02]">
                        <div className="space-y-6">
                          <div>
                            <label className="text-[12.5px] font-medium text-muted mb-2 block">Order info</label>
                            <div className="bg-surface border border-line rounded-control p-4 space-y-3">
                              <div className="flex items-center justify-between">
                                 <span className="text-[13px] text-muted font-medium">Customer</span>
                                 <span className="text-[13px] text-ink font-semibold">{del.order.customerName}</span>
                              </div>
                              <div className="flex items-center justify-between">
                                 <span className="text-[13px] text-muted font-medium">Material</span>
                                 <span className="text-[13px] text-ink font-semibold">{del.order.product}</span>
                              </div>
                              <div className="flex items-center justify-between">
                                 <span className="text-[13px] text-muted font-medium">Quantity</span>
                                 <span className="tabular text-[13px] text-ink font-semibold">{Number(del.order.quantity)} {del.order.unit}</span>
                              </div>
                            </div>
                          </div>
                          <div>
                            <label className="text-[12.5px] font-medium text-muted mb-2 block">Timeline</label>
                            <div className="flex items-center gap-6 text-[12.5px] font-medium text-muted">
                               <div className="flex flex-col">
                                 <span>Started</span>
                                 <span className="tabular text-ink">{del.startedAt ? new Date(del.startedAt).toLocaleTimeString() : '--:--'}</span>
                               </div>
                               <div className="flex flex-col">
                                 <span>Completed</span>
                                 <span className="tabular text-ink">{del.completedAt ? new Date(del.completedAt).toLocaleTimeString() : '--:--'}</span>
                               </div>
                            </div>
                          </div>
                        </div>

                        <div className="space-y-4">
                          <label className="text-[12.5px] font-medium text-muted mb-2 block">Evidence photos</label>
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <p className="text-[12.5px] font-medium text-muted mb-1">Pickup</p>
                              {del.pickupPhotoUrl ? (
                                <img src={del.pickupPhotoUrl} className="w-full h-32 object-cover rounded-control border border-line" alt="Pickup" />
                              ) : (
                                <div className="w-full h-32 bg-surface border border-dashed border-line rounded-control flex flex-col items-center justify-center text-muted">
                                  <ImageIcon size={20} />
                                  <span className="text-[12.5px] font-medium mt-1">No photo</span>
                                </div>
                              )}
                            </div>
                            <div>
                              <p className="text-[12.5px] font-medium text-muted mb-1">Delivery</p>
                              {del.deliveryPhotoUrl ? (
                                <img src={del.deliveryPhotoUrl} className="w-full h-32 object-cover rounded-control border border-line" alt="Delivery" />
                              ) : (
                                <div className="w-full h-32 bg-surface border border-dashed border-line rounded-control flex flex-col items-center justify-center text-muted">
                                  <ImageIcon size={20} />
                                  <span className="text-[12.5px] font-medium mt-1">No photo</span>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="space-y-4">
                          <label className="text-[12.5px] font-medium text-muted mb-2 block">Update history</label>
                          <div className="max-h-[200px] overflow-y-auto pr-2 bg-surface rounded-control border border-line p-4">
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
