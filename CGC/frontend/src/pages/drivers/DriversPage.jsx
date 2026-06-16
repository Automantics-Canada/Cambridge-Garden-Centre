import React, { useState, useEffect } from 'react';
import { Plus, Truck } from 'lucide-react';
import api from '../../api/axios';
import { supabase } from '../../supabaseClient';
import DriverCard from '../../components/drivers/DriverCard';
import AddDriverModal from '../../components/drivers/AddDriverModal';
import EditDriverModal from '../../components/drivers/EditDriverModal';
import { DriverCardSkeleton } from '../../components/Skeleton';
import { FadeInUp, StaggerContainer, StaggerItem } from '../../components/Animated';

export default function DriversPage() {
  const [drivers, setDrivers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingDriver, setEditingDriver] = useState(null);

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
                <DriverCard driver={driver} onEdit={(d) => setEditingDriver(d)} />
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
    </div>
  );
}