import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api/axios';
import { MapPin, Camera, CheckCircle2, Navigation, AlertCircle } from 'lucide-react';

export default function DriverMobileView() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const [deliveries, setDeliveries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [driverInfo, setDriverInfo] = useState(null);

  useEffect(() => {
    // In a real app, this endpoint would decode the token, authenticate, and return the driver's today deliveries.
    // We'll mock it calling deliveries with a specific param or just assume driverId is embedded in token for demo.
    // We'll extract driverId from the base64 token "driverId:date".
    const fetchMobileData = async () => {
      try {
        setLoading(true);
        if(!token) throw new Error("Invalid access link");
        
        const decoded = atob(token);
        const [driverId, date] = decoded.split(':');
        
        // Fetch driver info
        const driverRes = await api.get('/api/drivers');
        const me = driverRes.data.find(d => d.id === driverId);
        setDriverInfo(me);

        // Fetch deliveries
        const delRes = await api.get(`/api/deliveries?driverId=${driverId}`);
        // Filter for today or active ones
        setDeliveries(delRes.data.filter(d => d.status !== 'DELIVERED'));
      } catch (e) {
        console.error(e);
        setError("Invalid or expired access link.");
      } finally {
        setLoading(false);
      }
    };
    fetchMobileData();
  }, [token]);

  const handleStatusChange = async (id, newStatus) => {
    try {
      await api.post(`/api/deliveries/${id}/status`, { status: newStatus });
      setDeliveries(prev => prev.map(d => d.id === id ? { ...d, status: newStatus } : d));
    } catch (e) {
      alert("Failed to update status");
    }
  };

  const handlePhotoUpload = async (id, type, file) => {
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('type', type);
      await api.post(`/api/deliveries/${id}/photos`, formData);
      alert(`${type} photo uploaded successfully!`);
      // Update local state to reflect photo uploaded
      setDeliveries(prev => prev.map(d => {
        if(d.id === id) {
          if(type === 'pickup') d.pickupPhotoUrl = 'uploaded';
          if(type === 'delivery') d.deliveryPhotoUrl = 'uploaded';
        }
        return d;
      }));
    } catch (e) {
      alert(`Failed to upload ${type} photo`);
    }
  };

  if (loading) {
    return <div className="min-h-screen bg-gray-900 flex items-center justify-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-500"></div></div>;
  }

  if (error) {
    return <div className="min-h-screen bg-gray-900 flex items-center justify-center p-6 text-center text-red-400">
      <AlertCircle className="mx-auto mb-2" size={32}/>
      <p>{error}</p>
    </div>;
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 pb-24">
      <div className="sticky top-0 bg-gray-900/80 backdrop-blur-md border-b border-gray-800 p-4 z-10">
        <h1 className="text-xl font-bold text-white">Hey {driverInfo?.name.split(' ')[0]}</h1>
        <p className="text-gray-400 text-sm">You have {deliveries.length} active deliveries today.</p>
      </div>

      <div className="p-4 space-y-4">
        {deliveries.length === 0 ? (
          <div className="text-center p-8 bg-gray-900 rounded-2xl border border-gray-800 mt-8">
            <CheckCircle2 size={48} className="mx-auto text-green-500 mb-4" />
            <h2 className="text-lg font-bold text-white mb-1">All done!</h2>
            <p className="text-gray-400">You have no pending deliveries.</p>
          </div>
        ) : (
          deliveries.map(del => (
            <div key={del.id} className="bg-gray-900 rounded-2xl border border-gray-800 p-5 shadow-xl">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="font-bold text-lg text-white">{del.order.spruceOrderId}</h3>
                  <p className="text-sm text-gray-400">{del.order.customerName}</p>
                </div>
                <span className={`text-xs font-bold px-2 py-1 rounded border ${
                  del.status === 'IN_TRANSIT' ? 'bg-amber-900/30 text-amber-500 border-amber-900/50' :
                  del.status === 'PICKED_UP' ? 'bg-blue-900/30 text-blue-400 border-blue-900/50' :
                  'bg-gray-800 text-gray-300 border-gray-700'
                }`}>
                  {del.status.replace('_', ' ')}
                </span>
              </div>

              <div className="bg-gray-950 rounded-xl p-4 mb-4 border border-gray-800/50">
                <p className="font-medium text-gray-300 mb-1">{Number(del.order.quantity)} {del.order.unit} {del.order.product}</p>
                {del.order.supplier && <p className="text-xs text-gray-500">From: {del.order.supplier.name}</p>}
              </div>

              <div className="space-y-3">
                <a 
                  href={`https://maps.google.com/?q=${encodeURIComponent(del.order.customerName)}`} // Mock map link
                  target="_blank" rel="noopener noreferrer"
                  className="w-full flex items-center justify-center gap-2 bg-gray-800 hover:bg-gray-700 text-white py-3.5 rounded-xl font-semibold transition-colors"
                >
                  <Navigation size={18} />
                  Navigate
                </a>

                {/* Pickup Phase */}
                {del.status === 'ASSIGNED' && (
                  <>
                    {del.pickupType === 'EXTERNAL' && !del.pickupPhotoUrl && (
                       <label className="w-full flex items-center justify-center gap-2 bg-blue-900/20 border border-blue-800 hover:bg-blue-900/40 text-blue-400 py-3.5 rounded-xl font-semibold transition-colors cursor-pointer">
                         <Camera size={18} />
                         Upload Pickup Photo
                         <input type="file" className="hidden" accept="image/*" capture="environment" onChange={(e) => handlePhotoUpload(del.id, 'pickup', e.target.files[0])} />
                       </label>
                    )}
                    <button 
                      onClick={() => handleStatusChange(del.id, 'PICKED_UP')}
                      className={`w-full py-3.5 rounded-xl font-semibold transition-colors ${del.pickupType === 'EXTERNAL' && !del.pickupPhotoUrl ? 'bg-gray-800 text-gray-500 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-500 text-white'}`}
                      disabled={del.pickupType === 'EXTERNAL' && !del.pickupPhotoUrl}
                    >
                      Mark as Picked Up
                    </button>
                  </>
                )}

                {/* Transit Phase */}
                {del.status === 'PICKED_UP' && (
                  <button 
                    onClick={() => handleStatusChange(del.id, 'IN_TRANSIT')}
                    className="w-full py-3.5 rounded-xl font-semibold bg-amber-600 hover:bg-amber-500 text-white transition-colors"
                  >
                    Start Driving
                  </button>
                )}

                {/* Delivery Phase */}
                {del.status === 'IN_TRANSIT' && (
                  <>
                    {!del.deliveryPhotoUrl && (
                      <label className="w-full flex items-center justify-center gap-2 bg-gray-800 hover:bg-gray-700 text-white py-3.5 rounded-xl font-semibold transition-colors cursor-pointer">
                        <Camera size={18} />
                        Upload Delivery Photo
                        <input type="file" className="hidden" accept="image/*" capture="environment" onChange={(e) => handlePhotoUpload(del.id, 'delivery', e.target.files[0])} />
                      </label>
                    )}
                    <button 
                      onClick={() => handleStatusChange(del.id, 'DELIVERED')}
                      className={`w-full py-3.5 rounded-xl font-bold transition-colors shadow-lg ${!del.deliveryPhotoUrl ? 'bg-gray-800 text-gray-500 cursor-not-allowed' : 'bg-green-600 hover:bg-green-500 text-white shadow-green-900/50'}`}
                      disabled={!del.deliveryPhotoUrl}
                    >
                      Done (Delivered)
                    </button>
                  </>
                )}

              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
