import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api/axios';
import { MapPin, Camera, CheckCircle2, Navigation, AlertCircle, Clock, Package, Flag } from 'lucide-react';
import { toast } from 'react-hot-toast';

import { MobileDriverSkeleton } from '../../components/Skeleton';

export default function DriverMobileView() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const [deliveries, setDeliveries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [driverInfo, setDriverInfo] = useState(null);

  const fetchMobileData = async () => {
    try {
      setLoading(true);
      if(!token) throw new Error("Invalid access link");
      
      const decoded = atob(token);
      const [driverId, date] = decoded.split(':');
      
      const [driverRes, delRes] = await Promise.all([
        api.get('/api/drivers'),
        api.get(`/api/deliveries?driverId=${driverId}`)
      ]);

      const me = driverRes.data.find(d => d.id === driverId);
      setDriverInfo(me);
      
      // Sort by priority and filter active
      const active = delRes.data
        .filter(d => d.status !== 'DELIVERED' && d.status !== 'CANCELLED')
        .sort((a, b) => (a.priority || 0) - (b.priority || 0));
      
      setDeliveries(active);
    } catch (e) {
      console.error(e);
      setError("Invalid or expired access link.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMobileData();
  }, [token]);

  const handleStatusChange = async (id, newStatus, notes) => {
    try {
      await api.patch(`/api/deliveries/${id}/status`, { status: newStatus, notes });
      toast.success(`Status: ${newStatus.replace(/_/g, ' ')}`);
      fetchMobileData();
    } catch (e) {
      toast.error("Failed to update status");
    }
  };

  const handlePhotoUpload = async (id, type, file) => {
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('type', type);
      await api.post(`/api/deliveries/${id}/photos`, formData);
      toast.success(`Photo uploaded!`);
      fetchMobileData();
    } catch (e) {
      toast.error(`Failed to upload photo`);
    }
  };

  if (loading) return <MobileDriverSkeleton />;

  if (error) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center p-8 text-center">
        <div className="bg-gray-900 border border-red-900/30 p-8 rounded-3xl shadow-2xl">
          <AlertCircle className="mx-auto mb-4 text-red-500" size={48}/>
          <h2 className="text-xl font-black text-white mb-2">Access Denied</h2>
          <p className="text-gray-400 text-sm leading-relaxed">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-gray-100 pb-24 font-sans selection:bg-[#2D6A4F]">
      {/* Mobile Header */}
      <div className="sticky top-0 bg-black/80 backdrop-blur-xl border-b border-gray-800/50 p-6 z-20 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-white tracking-tight">CGC Logistics</h1>
          <p className="text-[#2D6A4F] text-xs font-black uppercase tracking-widest mt-1">Driver Portal • {driverInfo?.name}</p>
        </div>
        <div className="w-10 h-10 rounded-2xl bg-[#1B4332] flex items-center justify-center font-black text-sm border border-[#2D6A4F]/30">
          {driverInfo?.name?.split(' ').map(n => n[0]).join('').toUpperCase()}
        </div>
      </div>

      <div className="p-4 space-y-6">
        {deliveries.length === 0 ? (
          <div className="text-center py-20 px-8 bg-gray-900/40 rounded-[2.5rem] border border-gray-800/50 mt-10">
            <div className="w-20 h-20 bg-green-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
              <CheckCircle2 size={40} className="text-green-500" />
            </div>
            <h2 className="text-2xl font-black text-white mb-2 tracking-tight">Mission Accomplished</h2>
            <p className="text-gray-400 text-sm leading-relaxed">All deliveries have been completed. Safe travels back to the depot!</p>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="px-2 flex items-center justify-between">
               <h2 className="text-xs font-black text-gray-500 uppercase tracking-[0.2em]">Today's Sequence</h2>
               <span className="bg-gray-800 text-gray-400 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest">
                 {deliveries.length} REMAINING
               </span>
            </div>

            {deliveries.map((del, idx) => (
              <div key={del.id} className={`relative overflow-hidden transition-all duration-500 ${idx === 0 ? 'bg-gray-900 ring-1 ring-[#2D6A4F]/30' : 'bg-gray-900/40 opacity-70'} rounded-[2.5rem] border border-gray-800/50 p-7 shadow-2xl`}>
                {idx === 0 && (
                   <div className="absolute top-0 right-0 bg-[#2D6A4F] text-white px-4 py-1.5 rounded-bl-2xl text-[10px] font-black tracking-widest uppercase shadow-lg shadow-[#2D6A4F]/20 animate-pulse">
                     Next Stop
                   </div>
                )}

                <div className="flex items-start gap-4 mb-6">
                  <div className={`w-12 h-12 rounded-2xl flex flex-col items-center justify-center border font-black ${idx === 0 ? 'bg-[#2D6A4F] border-[#2D6A4F] text-white' : 'bg-gray-800 border-gray-700 text-gray-500'}`}>
                    <span className="text-[10px] uppercase leading-none opacity-60 mb-0.5">PRI</span>
                    <span className="text-lg leading-none">{idx + 1}</span>
                  </div>
                  <div>
                    <h3 className="font-black text-xl text-white tracking-tight leading-none">{del.order.spruceOrderId}</h3>
                    <p className="text-gray-400 text-xs font-bold uppercase mt-2 tracking-wide">{del.order.customerName}</p>
                  </div>
                </div>

                <div className="bg-black/40 backdrop-blur-sm rounded-3xl p-5 mb-6 border border-white/5 space-y-4">
                  <div className="flex items-center gap-4 text-sm">
                    <Package className="text-[#2D6A4F]" size={18} />
                    <div>
                      <p className="font-black text-white leading-none">{Number(del.order.quantity)} {del.order.unit}</p>
                      <p className="text-[10px] text-gray-500 font-bold uppercase mt-1 tracking-widest">{del.order.product}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-sm pt-4 border-t border-white/5">
                    <MapPin className="text-red-500" size={18} />
                    <p className="font-bold text-gray-300 text-xs leading-relaxed uppercase">78 Hespeler Rd, Cambridge, ON</p>
                  </div>
                </div>

                <div className="space-y-3">
                  <a 
                    href={`https://maps.google.com/?q=${encodeURIComponent(del.order.customerName)}`}
                    target="_blank" rel="noopener noreferrer"
                    className="w-full flex items-center justify-center gap-3 bg-gray-800 hover:bg-gray-700 text-white py-4 rounded-2xl font-black text-sm transition-all active:scale-[0.98] tracking-widest uppercase border border-gray-700/50"
                  >
                    <Navigation size={18} className="text-[#2D6A4F]" />
                    GET DIRECTIONS
                  </a>

                  {/* Status Buttons */}
                  {del.status === 'PLACED' && (
                    <button 
                      onClick={() => handleStatusChange(del.id, 'IN_TRANSIT', 'Driver confirmed and started delivery')}
                      className="w-full py-4 rounded-2xl font-black bg-[#2D6A4F] hover:bg-[#1B4332] text-white transition-all active:scale-[0.98] text-sm tracking-widest uppercase shadow-lg shadow-[#2D6A4F]/20"
                    >
                      CONFIRM & START
                    </button>
                  )}

                  {del.status === 'IN_TRANSIT' && (
                    <>
                      {/* Photo Upload Mandatory for External or as proof */}
                      {!del.deliveryPhotoUrl && (
                        <label className="w-full flex items-center justify-center gap-3 bg-indigo-600/20 border border-indigo-500 hover:bg-indigo-600/30 text-indigo-400 py-4 rounded-2xl font-black text-sm transition-all active:scale-[0.98] tracking-widest uppercase cursor-pointer">
                          <Camera size={18} />
                          UPLOAD PROOF PHOTO
                          <input type="file" className="hidden" accept="image/*" capture="environment" onChange={(e) => handlePhotoUpload(del.id, 'delivery', e.target.files[0])} />
                        </label>
                      )}
                      
                      <button 
                        onClick={() => handleStatusChange(del.id, 'DELIVERED', 'Delivered by driver')}
                        disabled={driverInfo?.type === 'INDEPENDENT' && !del.deliveryPhotoUrl}
                        className={`w-full py-4 rounded-2xl font-black transition-all active:scale-[0.98] text-sm tracking-widest uppercase shadow-lg ${
                          (driverInfo?.type === 'INDEPENDENT' && !del.deliveryPhotoUrl) 
                          ? 'bg-gray-800 text-gray-500 opacity-50 cursor-not-allowed' 
                          : 'bg-green-600 hover:bg-green-500 text-white shadow-green-900/40'
                        }`}
                      >
                        {driverInfo?.type === 'INDEPENDENT' && !del.deliveryPhotoUrl ? 'UPLOAD PHOTO FIRST' : 'MARK AS DELIVERED'}
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
