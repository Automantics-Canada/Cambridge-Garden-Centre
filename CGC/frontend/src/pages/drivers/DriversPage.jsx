import React, { useState, useEffect } from 'react';
import { Plus, Truck } from 'lucide-react';
import api from '../../api/axios';
import DriverCard from '../../components/drivers/DriverCard';
import AddDriverModal from '../../components/drivers/AddDriverModal';

export default function DriversPage() {
  const [drivers, setDrivers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const fetchDrivers = async () => {
    try {
      setLoading(true);
      const response = await api.get('/api/drivers');
      setDrivers(response.data);
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
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Drivers</h1>
          <p className="text-sm text-gray-500">Manage your delivery fleet and track performance.</p>
        </div>
        <button 
          onClick={() => setIsModalOpen(true)}
          className="flex items-center gap-2 bg-[#2D6A4F] hover:bg-[#1B4332] text-white px-4 py-2 rounded-lg font-semibold transition-colors shadow-sm"
        >
          <Plus size={18} />
          Add Driver
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#2D6A4F]"></div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {drivers.map(driver => (
            <DriverCard key={driver.id} driver={driver} />
          ))}
          {drivers.length === 0 && (
            <div className="col-span-full bg-white border border-dashed border-gray-300 rounded-xl p-12 text-center">
              <Truck className="mx-auto h-12 w-12 text-gray-400 mb-4" />
              <h3 className="text-lg font-medium text-gray-900">No drivers found</h3>
              <p className="text-gray-500">Get started by adding your first driver to the system.</p>
            </div>
          )}
        </div>
      )}

      {isModalOpen && (
        <AddDriverModal 
          isOpen={isModalOpen} 
          onClose={() => setIsModalOpen(false)} 
          onSuccess={fetchDrivers} 
        />
      )}
    </div>
  );
}
