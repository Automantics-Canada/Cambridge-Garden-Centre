import React, { useState, useEffect } from 'react';
import { Plus, Truck, Trash2 } from 'lucide-react';
import api from '../../api/axios';
import { supabase } from '../../supabaseClient';
import DriverCard from '../../components/drivers/DriverCard';
import AddDriverModal from '../../components/drivers/AddDriverModal';
import EditDriverModal from '../../components/drivers/EditDriverModal';
import { DriverCardSkeleton } from '../../components/Skeleton';
import { FadeInUp, StaggerContainer, StaggerItem } from '../../components/Animated';
import toast from 'react-hot-toast';

export default function DriversPage() {
  const [drivers, setDrivers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingDriver, setEditingDriver] = useState(null);
  const [deletingDriver, setDeletingDriver] = useState(null);
  const [deletingLoading, setDeletingLoading] = useState(false);

  const fetchDrivers = async () => {
    try {
      setLoading(true);
      const token = localStorage.getItem('token');
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      
      const { data, error } = await supabase.functions.invoke('fetch-cgc-data?resource=drivers&limit=1000', {
        method: 'GET',
        headers
      });

      if (error) throw error;
      setDrivers(data && data.data ? data.data : []);
    } catch (error) {
      console.error('Error fetching drivers:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteDriver = async () => {
    if (!deletingDriver) return;
    setDeletingLoading(true);
    try {
      await api.delete(`/api/drivers/${deletingDriver.id}`);
      toast.success('Driver deleted successfully');
      setDeletingDriver(null);
      fetchDrivers();
    } catch (error) {
      console.error('Error deleting driver:', error);
      toast.error(error.response?.data?.error || 'Failed to delete driver');
    } finally {
      setDeletingLoading(false);
    }
  };

  useEffect(() => {
    fetchDrivers();
  }, []);

  return (
    <div className="space-y-6">
      <FadeInUp className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Drivers</h1>
          <p className="text-sm text-gray-500">
            Manage your delivery fleet and track performance.
          </p>
        </div>

        <button
          onClick={() => setIsModalOpen(true)}
          className="flex items-center gap-2 bg-[#2D6A4F] hover:bg-[#1B4332] text-white px-4 py-2 rounded-lg font-semibold transition-colors shadow-sm"
        >
          <Plus size={18} />
          Add Driver
        </button>
      </FadeInUp>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <DriverCardSkeleton />
          <DriverCardSkeleton />
          <DriverCardSkeleton />
          <DriverCardSkeleton />
          <DriverCardSkeleton />
          <DriverCardSkeleton />
        </div>
      ) : (
        <StaggerContainer className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {drivers.length > 0 ? (
            drivers.map((driver) => (
              <StaggerItem key={driver.id}>
                <DriverCard 
                  driver={driver} 
                  onEdit={(d) => setEditingDriver(d)} 
                  onDelete={(d) => setDeletingDriver(d)} 
                />
              </StaggerItem>
            ))
          ) : (
            <StaggerItem className="col-span-full">
              <div className="bg-white border border-dashed border-gray-300 rounded-xl p-12 text-center">
                <Truck className="mx-auto h-12 w-12 text-gray-400 mb-4" />
                <h3 className="text-lg font-medium text-gray-900">No drivers found</h3>
                <p className="text-gray-500">
                  Get started by adding your first driver to the system.
                </p>
              </div>
            </StaggerItem>
          )}
        </StaggerContainer>
      )}

      {isModalOpen && (
        <AddDriverModal
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          onSuccess={fetchDrivers}
        />
      )}

      {editingDriver && (
        <EditDriverModal
          isOpen={!!editingDriver}
          driver={editingDriver}
          onClose={() => setEditingDriver(null)}
          onSuccess={fetchDrivers}
        />
      )}

      {deletingDriver && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 backdrop-blur-[2px] transition-all">
          <div className="bg-white rounded-2xl w-full max-w-md overflow-hidden shadow-2xl p-6 space-y-6 animate-in fade-in zoom-in duration-200">
            <div className="flex flex-col items-center text-center space-y-3">
              <div className="w-12 h-12 rounded-full bg-red-50 text-red-600 flex items-center justify-center">
                <Trash2 size={24} />
              </div>
              <h2 className="text-xl font-bold text-gray-900">Delete Driver</h2>
              <p className="text-sm text-gray-500 leading-relaxed">
                Are you sure you want to delete driver <span className="font-semibold text-gray-800">{deletingDriver.name}</span>? This action cannot be undone and will delete their associated user login.
              </p>
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setDeletingDriver(null)}
                disabled={deletingLoading}
                className="flex-1 px-4 py-3 rounded-xl border border-gray-200 text-gray-700 font-bold hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteDriver}
                disabled={deletingLoading}
                className="flex-1 px-4 py-3 rounded-xl bg-red-600 text-white font-bold hover:bg-red-700 transition-colors shadow-lg shadow-red-600/20 disabled:opacity-50"
              >
                {deletingLoading ? 'Deleting...' : 'Yes, Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}