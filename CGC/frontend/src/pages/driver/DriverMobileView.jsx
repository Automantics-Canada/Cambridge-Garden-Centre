import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSelector, useDispatch } from 'react-redux';
import api from '../../api/axios';
import { supabase } from '../../supabaseClient';
import { logout } from '../../store/authSlice';
import { MapPin, Camera, CheckCircle2, Navigation, AlertCircle, Clock, Package, Flag, User, LogOut } from 'lucide-react';
import { toast } from 'react-hot-toast';

import { MobileDriverSkeleton } from '../../components/Skeleton';

export default function DriverMobileView() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  
  const dispatch = useDispatch();
  const { isAuthenticated } = useSelector((state) => state.auth);

  const [deliveries, setDeliveries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [driverInfo, setDriverInfo] = useState(null);
  const [activeTab, setActiveTab] = useState('orders'); // 'orders' | 'profile'

  const fetchMobileData = async () => {
    try {
      setLoading(true);
      
      let driverRes, delRes;
      if (token) {
        // Legacy URL token access
        [driverRes, delRes] = await Promise.all([
          api.get(`/api/drivers/me?token=${token}`),
          api.get(`/api/deliveries?token=${token}`)
        ]);
      } else if (isAuthenticated) {
        // Standard session authenticated access
        [driverRes, delRes] = await Promise.all([
          api.get('/api/drivers/me'),
          api.get('/api/deliveries')
        ]);
      } else {
        throw new Error("Missing session or access link");
      }

      setDriverInfo(driverRes.data);
      
      // Sort by priority and filter active
      const active = delRes.data
        .filter(d => d.status !== 'DELIVERED' && d.status !== 'CANCELLED')
        .sort((a, b) => (a.priority || 0) - (b.priority || 0));
      
      setDeliveries(active);
    } catch (e) {
      console.error(e);
      setError("Invalid or expired access session.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMobileData();
  }, [token, isAuthenticated]);

  // Set up Supabase Realtime Subscription for instant real-time synchronization
  useEffect(() => {
    if (!driverInfo?.id) return;

    console.log(`[REALTIME] Subscribing to Delivery changes for driverId: ${driverInfo.id}`);

    const channel = supabase
      .channel(`driver-deliveries-${driverInfo.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'Delivery',
          filter: `driverId=eq.${driverInfo.id}`
        },
        (payload) => {
          console.log('[REALTIME] Delivery update detected:', payload);
          // Refetch active deliveries instantly
          fetchMobileData();
        }
      )
      .subscribe((status) => {
        console.log(`[REALTIME] Subscription status: ${status}`);
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [driverInfo?.id]);

  const handleStatusChange = async (id, newStatus, notes) => {
    try {
      const url = token 
        ? `/api/deliveries/${id}/status?token=${token}` 
        : `/api/deliveries/${id}/status`;
      await api.patch(url, { status: newStatus, notes });
      toast.success(`Status: ${newStatus.replace(/_/g, ' ')}`);
      fetchMobileData();
    } catch (e) {
      toast.error("Failed to update status");
    }
  };

  const handlePhotoUpload = async (id, type, file) => {
    if (!file) return;
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('type', type);
      
      const url = token 
        ? `/api/deliveries/${id}/photos?token=${token}` 
        : `/api/deliveries/${id}/photos`;
      await api.post(url, formData);
      toast.success(`${type === 'pickup' ? 'Pickup' : 'Delivery'} photo uploaded!`);
      fetchMobileData();
    } catch (e) {
      toast.error(`Failed to upload photo`);
    }
  };

  const handleLogout = () => {
    dispatch(logout());
  };

  if (loading) return <MobileDriverSkeleton />;

  if (error) {
    return (
      <div className="min-h-screen bg-[#F9FBF9] flex items-center justify-center p-8 text-center">
        <div className="bg-white border border-red-100 p-8 rounded-[2.5rem] shadow-xl shadow-red-500/5 max-w-sm mx-auto">
          <AlertCircle className="mx-auto mb-4 text-red-500" size={48} strokeWidth={1.5} />
          <h2 className="text-xl font-semibold text-slate-800 mb-2">Access Denied</h2>
          <p className="text-slate-500 text-sm font-normal leading-relaxed">{error}</p>
        </div>
      </div>
    );
  }

  // Enforce single active order view constraint
  const currentDelivery = deliveries[0];

  return (
    <div className="min-h-screen bg-[#F9FBF9] text-slate-800 pb-28 font-sans selection:bg-[#2D6A4F] selection:text-white">
      <div className="max-w-md mx-auto bg-white min-h-screen shadow-2xl shadow-slate-200 flex flex-col justify-between">
        
        <div>
          {/* Mobile Header */}
          <div className="sticky top-0 bg-white/90 backdrop-blur-xl border-b border-slate-100 p-5 z-20 flex items-center justify-between">
            <div className="flex flex-col">
              <h1 className="text-xl font-semibold text-slate-900 tracking-tight">CGC Logistics</h1>
              <div className="flex items-center gap-2 mt-0.5">
                <div className="w-1.5 h-1.5 rounded-full bg-[#2D6A4F] animate-pulse" />
                <p className="text-[#2D6A4F] text-[10px] font-semibold uppercase tracking-widest">{driverInfo?.name || 'Driver'}</p>
              </div>
            </div>
            
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-[#F0F7F4] flex items-center justify-center font-semibold text-sm text-[#2D6A4F] border border-[#2D6A4F]/10">
                {driverInfo?.name?.split(' ').map(n => n[0]).join('').toUpperCase() || 'D'}
              </div>
              
              {isAuthenticated && (
                <button 
                  onClick={handleLogout}
                  className="w-10 h-10 rounded-xl bg-red-50 hover:bg-red-100 flex items-center justify-center text-red-600 transition-colors border border-red-100"
                  title="Logout"
                >
                  <LogOut size={16} />
                </button>
              )}
            </div>
          </div>

          <div className="p-4 space-y-6">
            {activeTab === 'orders' ? (
              // Active Tasks view
              !currentDelivery ? (
                <div className="text-center py-20 px-8 bg-white rounded-[2.5rem] border border-slate-100 mt-10">
                  <div className="w-20 h-20 bg-[#F0F7F4] rounded-full flex items-center justify-center mx-auto mb-6">
                    <CheckCircle2 size={40} className="text-[#2D6A4F]" strokeWidth={2} />
                  </div>
                  <h2 className="text-2xl font-semibold text-slate-900 mb-2 tracking-tight">Mission Accomplished</h2>
                  <p className="text-slate-500 text-sm font-normal leading-relaxed">All deliveries have been completed.<br/>Safe travels back to the depot!</p>
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="px-2 flex items-center justify-between">
                     <h2 className="text-[10px] font-semibold text-slate-400 uppercase tracking-[0.2em]">Active Task</h2>
                     <span className="bg-[#2D6A4F] text-white px-3 py-1 rounded-full text-[10px] font-semibold uppercase tracking-widest">
                       {deliveries.length} Stop{deliveries.length > 1 ? 's' : ''} Remaining
                     </span>
                  </div>

                  <div className="relative overflow-hidden transition-all duration-500 bg-white ring-1 ring-[#2D6A4F]/20 shadow-xl shadow-[#2D6A4F]/10 rounded-[2rem] border border-slate-100 p-6">
                    <div className="absolute top-0 right-0 bg-[#2D6A4F] text-white px-4 py-1.5 rounded-bl-2xl text-[10px] font-semibold tracking-widest uppercase">
                      In Progress
                    </div>

                    <div className="flex items-start gap-4 mb-6">
                      <div className="w-12 h-12 rounded-2xl flex flex-col items-center justify-center border bg-[#2D6A4F] border-[#2D6A4F] text-white">
                        <span className="text-[8px] font-semibold uppercase leading-none opacity-60 mb-0.5">STOP</span>
                        <span className="text-lg font-semibold leading-none">1</span>
                      </div>
                      <div className="flex-1 pt-1">
                        <h3 className="font-semibold text-xl text-slate-900 tracking-tight leading-none">{currentDelivery.order.spruceOrderId}</h3>
                        <p className="text-slate-600 text-xs font-normal uppercase mt-2 tracking-wide truncate max-w-[180px]">{currentDelivery.order.customerName}</p>
                      </div>
                    </div>

                    <div className="bg-[#F9FBF9] rounded-2xl p-5 mb-6 border border-slate-200/50 space-y-4">
                      <div className="flex items-center gap-4 text-sm">
                        <div className="w-8 h-8 rounded-full bg-white flex items-center justify-center shadow-sm border border-slate-100">
                          <Package className="text-[#2D6A4F]" size={16} strokeWidth={2} />
                        </div>
                        <div>
                          <p className="font-semibold text-slate-800 leading-none">{Number(currentDelivery.order.quantity)} {currentDelivery.order.unit}</p>
                          <p className="text-[10px] text-slate-500 font-normal uppercase mt-1 tracking-widest">{currentDelivery.order.product}</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-4 text-sm pt-4 border-t border-slate-200/40">
                        <div className="w-8 h-8 rounded-full bg-white flex items-center justify-center shadow-sm border border-slate-100 flex-shrink-0">
                          <MapPin className="text-red-500" size={16} strokeWidth={2} />
                        </div>
                        <p className="font-normal text-slate-600 text-xs leading-relaxed uppercase pt-1">{currentDelivery.order.shippingAddress || '78 Hespeler Rd, Cambridge, ON'}</p>
                      </div>
                    </div>

                    <div className="space-y-3">
                      <a 
                        href={`https://maps.google.com/?q=${encodeURIComponent(currentDelivery.order.shippingAddress || currentDelivery.order.customerName)}`}
                        target="_blank" rel="noopener noreferrer"
                        className="w-full flex items-center justify-center gap-3 bg-white hover:bg-slate-50 text-slate-700 py-4 rounded-xl font-semibold text-xs transition-all active:scale-[0.98] tracking-widest uppercase border border-slate-200"
                      >
                        <Navigation size={16} className="text-[#2D6A4F]" strokeWidth={2} />
                        GET DIRECTIONS
                      </a>

                      {/* Status Buttons */}
                      {currentDelivery.status === 'PLACED' && (
                        <button 
                          onClick={() => handleStatusChange(currentDelivery.id, 'IN_TRANSIT', 'Driver confirmed and started delivery')}
                          className="w-full py-4 rounded-xl font-semibold bg-[#2D6A4F] hover:bg-[#1B4332] text-white transition-all active:scale-[0.98] text-xs tracking-widest uppercase shadow-lg shadow-[#2D6A4F]/20"
                        >
                          CONFIRM & START
                        </button>
                      )}

                      {currentDelivery.status === 'IN_TRANSIT' && (
                        <>
                          {/* Photo Uploads */}
                          <div className="grid grid-cols-2 gap-3">
                            {!currentDelivery.pickupPhotoUrl ? (
                              <label className={`flex flex-col items-center justify-center gap-2 py-4 rounded-xl font-semibold text-[10px] tracking-widest uppercase cursor-pointer border transition-all active:scale-[0.98] ${
                                driverInfo?.type === 'INDEPENDENT'
                                  ? 'bg-orange-50 border-orange-200 text-orange-700'
                                  : 'bg-slate-50 border-slate-200 text-slate-600'
                              }`}>
                                <Camera size={18} strokeWidth={2} />
                                PICKUP PHOTO
                                <input
                                  type="file"
                                  className="hidden"
                                  accept="image/*"
                                  capture="environment"
                                  onChange={(e) => handlePhotoUpload(currentDelivery.id, 'pickup', e.target.files?.[0])}
                                />
                              </label>
                            ) : (
                              <div className="flex flex-col items-center justify-center gap-2 bg-green-50 border border-green-200 text-green-700 py-4 rounded-xl text-[10px] font-semibold uppercase">
                                <CheckCircle2 size={18} strokeWidth={2} /> PICKUP OK
                              </div>
                            )}

                            {!currentDelivery.deliveryPhotoUrl ? (
                              <label className="flex flex-col items-center justify-center gap-2 bg-indigo-50 border border-indigo-200 text-indigo-700 py-4 rounded-xl font-semibold text-[10px] tracking-widest uppercase cursor-pointer transition-all active:scale-[0.98]">
                                <Camera size={18} strokeWidth={2} />
                                DELIVERY PHOTO
                                <input
                                  type="file"
                                  className="hidden"
                                  accept="image/*"
                                  capture="environment"
                                  onChange={(e) => handlePhotoUpload(currentDelivery.id, 'delivery', e.target.files?.[0])}
                                />
                              </label>
                            ) : (
                              <div className="flex flex-col items-center justify-center gap-2 bg-indigo-50 border border-indigo-200 text-indigo-700 py-4 rounded-xl text-[10px] font-semibold uppercase">
                                <CheckCircle2 size={18} strokeWidth={2} /> PROOF OK
                              </div>
                            )}
                          </div>

                          {/* MARK AS DELIVERED */}
                          <button 
                            onClick={() => handleStatusChange(currentDelivery.id, 'DELIVERED', 'Delivered by driver')}
                            className="w-full py-4 rounded-xl font-semibold bg-[#1B4332] hover:bg-[#0D2119] text-white transition-all active:scale-[0.98] text-xs tracking-widest uppercase shadow-lg shadow-green-900/20"
                          >
                            COMPLETE DELIVERY
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )
            ) : (
              // Read-only Profile view
              <div className="space-y-6">
                <div className="px-2">
                   <h2 className="text-[10px] font-semibold text-slate-400 uppercase tracking-[0.2em]">My Profile</h2>
                </div>

                <div className="bg-white border border-slate-100 rounded-[2rem] p-6 shadow-xl shadow-slate-200/50 space-y-6">
                  <div className="flex flex-col items-center py-4 border-b border-slate-100">
                    <div className="w-20 h-20 rounded-full bg-green-50 text-[#2D6A4F] border border-green-100 flex items-center justify-center font-bold text-3xl mb-3 shadow-inner">
                      {driverInfo?.name?.split(' ').map(n => n[0]).join('').toUpperCase() || 'D'}
                    </div>
                    <h3 className="text-xl font-bold text-slate-900">{driverInfo?.name}</h3>
                    <p className="text-xs text-[#2D6A4F] font-semibold uppercase tracking-wider mt-1">{driverInfo?.type === 'CGC_FLEET' ? 'CGC Fleet Driver' : 'Independent Contractor'}</p>
                  </div>

                  <div className="space-y-4">
                    <div className="flex justify-between items-center py-2 border-b border-slate-50">
                      <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Email Address</span>
                      <span className="text-sm font-semibold text-slate-800">{driverInfo?.email || 'N/A'}</span>
                    </div>

                    <div className="flex justify-between items-center py-2 border-b border-slate-50">
                      <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Phone Number</span>
                      <span className="text-sm font-semibold text-slate-800">{driverInfo?.phone || 'N/A'}</span>
                    </div>

                    <div className="flex justify-between items-center py-2 border-b border-slate-50">
                      <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Pay rate</span>
                      <span className="text-sm font-bold text-[#2D6A4F]">${driverInfo?.ratePerTrip} per Trip</span>
                    </div>

                    <div className="flex justify-between items-center py-2">
                      <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Account Status</span>
                      <div className="flex items-center gap-1.5 bg-green-50 border border-green-100 text-green-700 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide">
                        <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                        {driverInfo?.active ? 'Active' : 'Inactive'}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-slate-50 border border-slate-100 rounded-2xl p-5 text-center text-xs text-slate-400 leading-relaxed">
                  🔒 Profile details are locked and managed by CGC Dispatchers.<br />
                  If you need to update your details, please contact operations.
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Sleek Bottom Navigation Bar */}
        <div className="sticky bottom-0 w-full bg-white/95 backdrop-blur-xl border-t border-slate-100 py-4 flex justify-around items-center z-30 shadow-2xl">
          <button 
            onClick={() => setActiveTab('orders')}
            className={`flex flex-col items-center gap-1 transition-all duration-300 ${activeTab === 'orders' ? 'text-[#2D6A4F] scale-105 font-bold' : 'text-slate-400 hover:text-slate-600 font-medium'}`}
          >
            <Package size={20} strokeWidth={activeTab === 'orders' ? 2.5 : 2} />
            <span className="text-[10px] tracking-widest uppercase">Active Task</span>
          </button>
          
          <button 
            onClick={() => setActiveTab('profile')}
            className={`flex flex-col items-center gap-1 transition-all duration-300 ${activeTab === 'profile' ? 'text-[#2D6A4F] scale-105 font-bold' : 'text-slate-400 hover:text-slate-600 font-medium'}`}
          >
            <User size={20} strokeWidth={activeTab === 'profile' ? 2.5 : 2} />
            <span className="text-[10px] tracking-widest uppercase">My Profile</span>
          </button>
        </div>

      </div>
    </div>
  );
}
