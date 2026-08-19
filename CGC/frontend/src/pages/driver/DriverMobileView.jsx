import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSelector, useDispatch } from 'react-redux';
import api from '../../api/axios';
import { supabase } from '../../supabaseClient';
import { logout } from '../../store/authSlice';
import LogoutModal from '../../components/LogoutModal';
import { MapPin, Camera, CheckCircle2, AlertCircle, Package, User, LogOut } from 'lucide-react';
import { toast } from 'react-hot-toast';

import { MobileDriverSkeleton } from '../../components/Skeleton';
import { useIntervalRefresh } from '../../hooks/useIntervalRefresh';
import { Badge } from '../../components/ui';
import { cn } from '../../lib/cn';
import { formatQuantity } from '../../lib/quantity';

export default function DriverMobileView() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  const dispatch = useDispatch();
  const { isAuthenticated } = useSelector((state) => state.auth);

  const [deliveries, setDeliveries] = useState([]);
  // Reported by the server, because the client only ever holds one stop now.
  const [stopsRemaining, setStopsRemaining] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [driverInfo, setDriverInfo] = useState(null);
  const [activeTab, setActiveTab] = useState('orders'); // 'orders' | 'profile'
  const [uploadingType, setUploadingType] = useState(null); // 'pickup' | 'delivery' | 'ticket'
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [showLogoutModal, setShowLogoutModal] = useState(false);

  const fetchMobileData = useCallback(async (silent = false) => {
    try {
      if (!silent) {
        setLoading(true);
      }

      let driverInfoData, deliveriesData, remaining;
      if (token) {
        // Legacy URL token access
        const [driverRes, delRes] = await Promise.all([
          api.get(`/api/drivers/me?token=${token}`),
          api.get(`/api/deliveries?token=${token}`)
        ]);
        driverInfoData = driverRes.data;
        deliveriesData = delRes.data;
      } else if (isAuthenticated) {
        // Standard session authenticated access
        const userToken = localStorage.getItem('token');
        const headers = userToken ? { Authorization: `Bearer ${userToken}` } : {};

        const { data: meData, error: meError } = await supabase.functions.invoke('fetch-cgc-data?resource=drivers-me', {
          method: 'GET',
          headers
        });
        if (meError) throw meError;
        driverInfoData = meData;

        // The server returns the current stop only, and reports how many remain.
        // This used to ask for limit=1000 and hide all but the first row, which
        // put the whole day's route — customers, products, quantities — in the
        // browser of a driver who is only meant to see the stop they are on.
        const { data: delData, error: delError } = await supabase.functions.invoke(
          `fetch-cgc-data?resource=deliveries&driverId=${meData.id}`,
          { method: 'GET', headers }
        );
        if (delError) throw delError;
        deliveriesData = delData?.data || [];
        remaining = delData?.pagination?.totalCount;
      } else {
        throw new Error("Missing session or access link");
      }

      setDriverInfo(driverInfoData);

      // The token path still returns the full list, so the same rule is applied
      // here for it. The session path is already narrowed server-side.
      const active = (deliveriesData || [])
        .filter(d => d.status !== 'DELIVERED' && d.status !== 'CANCELLED')
        .sort((a, b) => (a.priority || 0) - (b.priority || 0));

      setDeliveries(active);
      setStopsRemaining(typeof remaining === 'number' ? remaining : active.length);
    } catch (e) {
      console.error(e);
      setError("Invalid or expired access session.");
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, token]);

  useEffect(() => {
    fetchMobileData();
  }, [fetchMobileData]);

  useIntervalRefresh(
    () => {
      fetchMobileData(true);
    },
    8_000,
    { enabled: Boolean(driverInfo?.id) && !uploadingType && !updatingStatus }
  );

  const handleStatusChange = async (id, newStatus, notes) => {
    try {
      setUpdatingStatus(true);
      const url = token
        ? `/api/deliveries/${id}/status?token=${token}`
        : `/api/deliveries/${id}/status`;
      await api.patch(url, { status: newStatus, notes });
      toast.success(`Status: ${newStatus.replace(/_/g, ' ')}`);
      await fetchMobileData(true);
    } catch (err) {
      // The server now refuses illegal transitions, forbidden roles and
      // missing proof of delivery with a specific reason. Show it — a blanket
      // "Failed to update status" leaves the driver with no way to proceed.
      const reason = err?.response?.data?.error;
      toast.error(reason || 'Failed to update status');
      // Someone else may have moved this delivery on; re-read so the buttons
      // reflect the real state rather than the one we just failed against.
      await fetchMobileData(true);
    } finally {
      setUpdatingStatus(false);
    }
  };

  const handlePhotoUpload = async (id, type, file) => {
    if (!file) return;
    try {
      setUploadingType(type);
      const formData = new FormData();
      formData.append('file', file);
      formData.append('type', type);

      const url = token
        ? `/api/deliveries/${id}/photos?token=${token}`
        : `/api/deliveries/${id}/photos`;
      await api.post(url, formData);
      toast.success(`${type === 'pickup' ? 'Pickup' : type === 'delivery' ? 'Delivery' : 'Ticket'} photo uploaded!`);
      await fetchMobileData(true);
    } catch (err) {
      const reason = err?.response?.data?.error;
      toast.error(reason || 'Failed to upload photo');
    } finally {
      setUploadingType(null);
    }
  };

  const handleLogout = () => {
    setShowLogoutModal(true);
  };

  if (error) {
    return (
      <div className="min-h-screen bg-canvas flex items-center justify-center p-8 text-center">
        <div className="bg-surface border border-clay/30 p-8 rounded-card shadow-lift max-w-sm mx-auto">
          <AlertCircle className="mx-auto mb-4 text-clay" size={48} strokeWidth={1.5} />
          <h2 className="text-xl font-semibold text-ink mb-2">Access denied</h2>
          <p className="text-muted text-sm font-normal leading-relaxed">{error}</p>
        </div>
      </div>
    );
  }

  // Enforce single active order view constraint
  const currentDelivery = deliveries[0];

  return (
    <div className="min-h-screen bg-canvas text-ink pb-28 font-sans">
      <div className="max-w-md mx-auto bg-surface min-h-screen shadow-lift flex flex-col justify-between">

        <div>
          <div className="sticky top-0 bg-surface/90 backdrop-blur-xl border-b border-line p-5 z-20 flex items-center justify-between">
            <div className="flex flex-col">
              <h1 className="text-xl font-semibold text-ink tracking-tight">CGC Logistics</h1>
              <div className="flex items-center gap-2 mt-0.5">
                <div className="w-1.5 h-1.5 rounded-pill bg-brand animate-pulse" />
                <p className="text-brand text-[13px] font-semibold">{driverInfo?.name || 'Driver'}</p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-control bg-brand/10 flex items-center justify-center font-semibold text-sm text-brand border border-brand/20">
                {driverInfo?.name?.split(' ').map(n => n[0]).join('').toUpperCase() || 'D'}
              </div>

              {isAuthenticated && (
                <button
                  onClick={handleLogout}
                  className="w-11 h-11 rounded-control bg-clay/14 hover:bg-clay/20 flex items-center justify-center text-clay transition-colors border border-clay/30"
                  title="Logout"
                >
                  <LogOut size={16} />
                </button>
              )}
            </div>
          </div>

          <div className="p-4 space-y-6">
            {loading ? (
              <MobileDriverSkeleton />
            ) : activeTab === 'orders' ? (
              !currentDelivery ? (
                <div className="text-center py-20 px-8 bg-surface rounded-card border border-line mt-10">
                  <div className="w-20 h-20 bg-brand/10 rounded-pill flex items-center justify-center mx-auto mb-6">
                    <CheckCircle2 size={40} className="text-brand" strokeWidth={2} />
                  </div>
                  <h2 className="text-2xl font-semibold text-ink mb-2 tracking-tight">All done for now</h2>
                  <p className="text-muted text-sm font-normal leading-relaxed">Every stop on your list is complete.<br/>Safe travels back to the depot.</p>
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="px-2 flex items-center justify-between">
                     <h2 className="text-[13px] font-semibold text-muted">Active task</h2>
                     <Badge tone="warn">
                       {stopsRemaining} stop{stopsRemaining === 1 ? '' : 's'} remaining
                     </Badge>
                  </div>

                  <div className="relative overflow-hidden transition-all duration-500 bg-surface border border-line shadow-card rounded-card p-6">
                    <div className="absolute top-0 right-0 bg-brand text-on-brand px-4 py-1.5 rounded-bl-card text-[13px] font-semibold">
                      In progress
                    </div>

                    <div className="flex items-start gap-4 mb-6">
                      <div className="w-12 h-12 rounded-control flex flex-col items-center justify-center border bg-brand border-brand text-on-brand">
                        <span className="text-[12.5px] font-semibold uppercase leading-none opacity-80 mb-0.5">Stop</span>
                        <span className="tabular text-lg font-semibold leading-none">1</span>
                      </div>
                      <div className="flex-1 pt-1">
                        <h3 className="font-semibold text-xl text-ink tracking-tight leading-none">{currentDelivery.order.spruceOrderId}</h3>
                        <p className="text-muted text-[13px] font-normal mt-2 truncate max-w-[180px]">{currentDelivery.order.customerName}</p>
                      </div>
                    </div>

                    <div className="bg-ink/[0.03] rounded-card p-5 mb-6 border border-line space-y-4">
                      <div className="flex items-center gap-4 text-sm">
                        <div className="w-8 h-8 rounded-pill bg-surface flex items-center justify-center shadow-card border border-line">
                          <Package className="text-brand" size={16} strokeWidth={2} />
                        </div>
                        <div>
                          <p className="tabular font-semibold text-ink leading-none">{formatQuantity(currentDelivery.order.quantity, currentDelivery.order.unit)}</p>
                          <p className="text-[13px] text-muted font-normal mt-1">{currentDelivery.order.product}</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-4 text-sm pt-4 border-t border-line">
                        <div className="w-8 h-8 rounded-pill bg-surface flex items-center justify-center shadow-card border border-line flex-shrink-0">
                          <MapPin className="text-clay" size={16} strokeWidth={2} />
                        </div>
                        <p className={`font-normal text-[13px] leading-relaxed pt-1 ${currentDelivery.order.shippingAddress ? 'text-muted' : 'text-clay'}`}>
                          {currentDelivery.order.shippingAddress || 'No delivery address on file. Ask dispatch before you leave.'}
                        </p>
                      </div>
                    </div>

                    <div className="space-y-3">
                      {/* <a
                        href={`https://maps.google.com/?q=${encodeURIComponent(currentDelivery.order.shippingAddress || currentDelivery.order.customerName)}`}
                        target="_blank" rel="noopener noreferrer"
                        className="w-full flex items-center justify-center gap-3 bg-surface hover:bg-ink/[0.03] text-ink py-4 rounded-control font-semibold text-[13px] transition-all active:scale-[0.98] border border-line min-h-11"
                      >
                        <Navigation size={16} className="text-brand" strokeWidth={2} />
                        Get directions
                      </a> */}

                      {currentDelivery.status === 'PLACED' && (
                        <button
                          onClick={() => handleStatusChange(currentDelivery.id, 'IN_TRANSIT', 'Driver confirmed and started delivery')}
                          disabled={uploadingType !== null || updatingStatus}
                          className="w-full min-h-11 py-4 rounded-pill font-semibold bg-brand hover:brightness-110 text-on-brand transition-all active:scale-[0.98] text-[15px] disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {updatingStatus ? 'Confirming...' : 'Confirm and start'}
                        </button>
                      )}

                      {currentDelivery.status === 'IN_TRANSIT' && (
                        <>
                          <div className="space-y-3">
                            <div className="grid grid-cols-2 gap-3">
                              {!currentDelivery.pickupPhotoUrl ? (
                                <label className={cn(
                                  'flex flex-col items-center justify-center gap-2 py-4 min-h-[88px] rounded-control font-semibold text-[13px] cursor-pointer border transition-all active:scale-[0.98]',
                                  uploadingType === 'pickup'
                                    ? 'bg-ink/[0.06] border-line text-muted cursor-not-allowed'
                                    : driverInfo?.type === 'INDEPENDENT'
                                    ? 'bg-ochre/15 border-ochre/30 text-ink'
                                    : 'bg-ink/[0.03] border-line text-ink'
                                )}>
                                  <Camera size={18} strokeWidth={2} className={uploadingType === 'pickup' ? 'animate-spin' : ''} />
                                  {uploadingType === 'pickup' ? 'Uploading...' : 'Pickup photo'}
                                  <input
                                    type="file"
                                    className="hidden"
                                    accept="image/*"
                                    capture="environment"
                                    disabled={uploadingType !== null || updatingStatus}
                                    onChange={(e) => handlePhotoUpload(currentDelivery.id, 'pickup', e.target.files?.[0])}
                                  />
                                </label>
                              ) : (
                                <div className="flex flex-col items-center justify-center gap-2 bg-brand/12 border border-brand/30 text-brand py-4 min-h-[88px] rounded-control text-[13px] font-semibold">
                                  <CheckCircle2 size={18} strokeWidth={2} /> Pickup ok
                                </div>
                              )}

                              {!currentDelivery.deliveryPhotoUrl ? (
                                <label className={cn(
                                  'flex flex-col items-center justify-center gap-2 py-4 min-h-[88px] rounded-control font-semibold text-[13px] cursor-pointer border transition-all active:scale-[0.98]',
                                  uploadingType === 'delivery'
                                    ? 'bg-ink/[0.06] border-line text-muted cursor-not-allowed'
                                    : 'bg-ink/[0.03] border-line text-ink'
                                )}>
                                  <Camera size={18} strokeWidth={2} className={uploadingType === 'delivery' ? 'animate-spin' : ''} />
                                  {uploadingType === 'delivery' ? 'Uploading...' : 'Delivery photo'}
                                  <input
                                    type="file"
                                    className="hidden"
                                    accept="image/*"
                                    capture="environment"
                                    disabled={uploadingType !== null || updatingStatus}
                                    onChange={(e) => handlePhotoUpload(currentDelivery.id, 'delivery', e.target.files?.[0])}
                                  />
                                </label>
                              ) : (
                                <div className="flex flex-col items-center justify-center gap-2 bg-brand/12 border border-brand/30 text-brand py-4 min-h-[88px] rounded-control text-[13px] font-semibold">
                                  <CheckCircle2 size={18} strokeWidth={2} /> Proof ok
                                </div>
                              )}
                            </div>

                            <div className="space-y-3 w-full">
                              {currentDelivery.order?.tickets?.map((t, idx) => (
                                <div key={t.id || idx} className="flex items-center justify-center gap-2 bg-brand/12 border border-brand/30 text-brand py-4 min-h-11 rounded-control text-[13px] font-semibold w-full">
                                  <CheckCircle2 size={18} strokeWidth={2} /> Ticket {idx + 1} ok
                                </div>
                              ))}

                              <label className={cn(
                                'flex flex-col items-center justify-center gap-2 py-4 min-h-11 rounded-control font-semibold text-[13px] cursor-pointer border transition-all active:scale-[0.98] w-full',
                                uploadingType === 'ticket'
                                  ? 'bg-ink/[0.06] border-line text-muted cursor-not-allowed'
                                  : 'bg-brand/10 border-brand/30 text-brand'
                              )}>
                                <Camera size={18} strokeWidth={2} className={uploadingType === 'ticket' ? 'animate-spin' : ''} />
                                {uploadingType === 'ticket' ? 'Uploading...' : (currentDelivery.order?.tickets?.length > 0 ? 'Upload another ticket' : 'Upload ticket')}
                                <input
                                  type="file"
                                  className="hidden"
                                  accept="image/*"
                                  capture="environment"
                                  disabled={uploadingType !== null || updatingStatus}
                                  onChange={(e) => handlePhotoUpload(currentDelivery.id, 'ticket', e.target.files?.[0])}
                                />
                              </label>
                            </div>

                          </div>

                          {/* The server refuses DELIVERED without a delivery
                              photo (422 MISSING_EVIDENCE). Mirror that here so
                              the driver sees why the button is unavailable
                              instead of tapping it and getting an error. */}
                          <button
                            onClick={() => handleStatusChange(currentDelivery.id, 'DELIVERED', 'Delivered by driver')}
                            disabled={uploadingType !== null || updatingStatus || !currentDelivery.deliveryPhotoUrl}
                            className="w-full min-h-11 py-4 rounded-pill font-semibold bg-brand hover:brightness-110 text-on-brand transition-all active:scale-[0.98] text-[15px] disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {updatingStatus ? 'Completing...' : 'Complete delivery'}
                          </button>
                          {!currentDelivery.deliveryPhotoUrl && (
                            <p className="text-[12.5px] text-muted text-center mt-2">
                              Add a delivery photo to complete this stop.
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )
            ) : (
              <div className="space-y-6">
                <div className="px-2">
                   <h2 className="text-[13px] font-semibold text-muted">My profile</h2>
                </div>

                <div className="bg-surface border border-line rounded-card p-6 shadow-card space-y-6">
                  <div className="flex flex-col items-center py-4 border-b border-line">
                    <div className="w-20 h-20 rounded-pill bg-brand/10 text-brand border border-brand/20 flex items-center justify-center font-bold text-3xl mb-3">
                      {driverInfo?.name?.split(' ').map(n => n[0]).join('').toUpperCase() || 'D'}
                    </div>
                    <h3 className="text-xl font-bold text-ink">{driverInfo?.name}</h3>
                    <p className="text-[13px] text-brand font-semibold mt-1">{driverInfo?.type === 'CGC_FLEET' ? 'CGC fleet driver' : 'Independent contractor'}</p>
                  </div>

                  <div className="space-y-4">
                    <div className="flex justify-between items-center py-2 border-b border-line">
                      <span className="text-[13px] font-medium text-muted">Email</span>
                      <span className="text-sm font-semibold text-ink">{driverInfo?.email || 'N/A'}</span>
                    </div>

                    <div className="flex justify-between items-center py-2 border-b border-line">
                      <span className="text-[13px] font-medium text-muted">Phone</span>
                      <span className="tabular text-sm font-semibold text-ink">{driverInfo?.phone || 'N/A'}</span>
                    </div>

                    <div className="flex justify-between items-center py-2 border-b border-line">
                      <span className="text-[13px] font-medium text-muted">Pay rate</span>
                      <span className="tabular text-sm font-bold text-ink">${driverInfo?.ratePerTrip} per trip</span>
                    </div>

                    <div className="flex justify-between items-center py-2">
                      <span className="text-[13px] font-medium text-muted">Account status</span>
                      <Badge tone={driverInfo?.active ? 'good' : 'neutral'}>
                        {driverInfo?.active ? 'Active' : 'Inactive'}
                      </Badge>
                    </div>
                  </div>
                </div>

                <div className="bg-ink/[0.03] border border-line rounded-card p-5 text-center text-[13px] text-muted leading-relaxed">
                  Profile details are locked and managed by CGC dispatchers.<br />
                  If you need to update your details, contact operations.
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="sticky bottom-0 w-full bg-surface/95 backdrop-blur-xl border-t border-line py-3 flex justify-around items-center z-30">
          <button
            onClick={() => setActiveTab('orders')}
            className={cn(
              'flex flex-col items-center justify-center gap-1 min-h-11 min-w-[88px] transition-colors',
              activeTab === 'orders' ? 'text-brand font-semibold' : 'text-muted hover:text-ink font-medium'
            )}
          >
            <Package size={20} strokeWidth={activeTab === 'orders' ? 2.5 : 2} />
            <span className="text-[13px]">Active task</span>
          </button>

          <button
            onClick={() => setActiveTab('profile')}
            className={cn(
              'flex flex-col items-center justify-center gap-1 min-h-11 min-w-[88px] transition-colors',
              activeTab === 'profile' ? 'text-brand font-semibold' : 'text-muted hover:text-ink font-medium'
            )}
          >
            <User size={20} strokeWidth={activeTab === 'profile' ? 2.5 : 2} />
            <span className="text-[13px]">My profile</span>
          </button>
        </div>

      </div>

      <LogoutModal
        isOpen={showLogoutModal}
        onClose={() => setShowLogoutModal(false)}
        onConfirm={() => dispatch(logout())}
      />
    </div>
  );
}
