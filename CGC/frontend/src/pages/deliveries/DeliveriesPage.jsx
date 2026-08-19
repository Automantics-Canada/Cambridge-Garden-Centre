import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api/axios';
import { Search, Calendar, ChevronDown, ChevronUp, User, Image as ImageIcon, X } from 'lucide-react';
import { DeliveryTableSkeleton } from '../../components/Skeleton';
import { FadeInUp } from '../../components/Animated';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'react-hot-toast';
import { Badge, Button, Card, EmptyState, Input, PageHeader, Select, StatusBadge } from '../../components/ui';
import StatusTimeline from '../../components/deliveries/StatusTimeline';
import { cn } from '../../lib/cn';
import { formatDate } from '../../lib/date';
import { isTerminal, statusErrorMessage, statusOptionsFor } from '../../lib/deliveryTransitions';
import { formatQuantity } from '../../lib/quantity';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';

export default function DeliveriesPage() {
  const [searchParams] = useSearchParams();
  const [deliveries, setDeliveries] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedDeliveryId, setExpandedDeliveryId] = useState(null);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, totalCount: 0 });

  // Search and Filter State
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDate, setSelectedDate] = useState('');
  const [selectedDriver, setSelectedDriver] = useState('');
  const debouncedSearch = useDebouncedValue(searchQuery, 350);
  const hasFilters = Boolean(searchQuery || selectedDate || selectedDriver);

  const driverIdParam = searchParams.get('driverId');

  const fetchDrivers = useCallback(async () => {
    try {
      const driverRes = await api.get('/api/drivers');
      setDrivers(Array.isArray(driverRes.data) ? driverRes.data : driverRes.data?.data || []);
    } catch (e) {
      console.error('Failed to fetch drivers', e);
      toast.error('Failed to load drivers');
    }
  }, []);

  const fetchDeliveries = useCallback(async () => {
    try {
      setLoading(true);
      const { data } = await api.get('/api/deliveries', {
        params: {
          page,
          limit: 25,
          ...(selectedDate ? { date: selectedDate } : {}),
          ...(selectedDriver ? { driverId: selectedDriver } : {}),
          ...(debouncedSearch ? { search: debouncedSearch } : {}),
        },
      });
      setDeliveries(Array.isArray(data) ? data : data?.data || []);
      setPagination(data?.pagination || { page: 1, totalPages: 1, totalCount: data?.length || 0 });
    } catch (e) {
      console.error('Failed to fetch deliveries', e);
      toast.error('Failed to load deliveries');
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, page, selectedDate, selectedDriver]);

  useEffect(() => {
    fetchDrivers();
  }, [fetchDrivers]);

  useEffect(() => {
    fetchDeliveries();
  }, [fetchDeliveries]);

  useEffect(() => {
    if (driverIdParam) {
      setSelectedDriver(driverIdParam);
      setPage(1);
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

  const filteredDeliveries = useMemo(
    () => [...deliveries].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
    [deliveries]
  );

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
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setPage(1);
                  }}
                />
                {searchQuery && (
                  <button
                    onClick={() => {
                      setSearchQuery('');
                      setPage(1);
                    }}
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
                    onChange={(e) => {
                      setSelectedDate(e.target.value);
                      setPage(1);
                    }}
                  />
                </div>

                <div className="relative min-w-[160px]">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" size={16} />
                  <Select
                    className="pl-10"
                    value={selectedDriver}
                    onChange={(e) => {
                      setSelectedDriver(e.target.value);
                      setPage(1);
                    }}
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
                      setPage(1);
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
            title={hasFilters ? 'No deliveries match' : 'No deliveries yet'}
            message={hasFilters ? 'Try another search, date, or driver.' : 'Deliveries appear here once dispatch assigns an order to a driver.'}
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
                                 <span className="tabular text-[13px] text-ink font-semibold">{formatQuantity(del.order.quantity, del.order.unit)}</span>
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

      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between gap-4">
          <Button
            variant="ghost"
            disabled={page <= 1}
            onClick={() => setPage(current => Math.max(1, current - 1))}
          >
            Previous
          </Button>
          <p className="text-[13px] font-medium text-muted tabular">
            Page {pagination.page} of {pagination.totalPages} · {pagination.totalCount} deliveries
          </p>
          <Button
            variant="ghost"
            disabled={page >= pagination.totalPages}
            onClick={() => setPage(current => Math.min(pagination.totalPages, current + 1))}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
