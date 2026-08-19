import React, { useState, useEffect } from 'react';
import { Plus, Truck, Trash2 } from 'lucide-react';
import api from '../../api/axios';
import DriverCard from '../../components/drivers/DriverCard';
import AddDriverModal from '../../components/drivers/AddDriverModal';
import EditDriverModal from '../../components/drivers/EditDriverModal';
import { DriverCardSkeleton } from '../../components/Skeleton';
import { FadeInUp, StaggerContainer, StaggerItem } from '../../components/Animated';
import toast from 'react-hot-toast';
import { Button, EmptyState, PageHeader } from '../../components/ui';

export default function DriversPage() {
  const [drivers, setDrivers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingDriver, setEditingDriver] = useState(null);
  const [deletingDriver, setDeletingDriver] = useState(null);
  const [deletingLoading, setDeletingLoading] = useState(false);

  /**
   * Reads go to the Express API, not the `fetch-cgc-data` Edge function.
   *
   * Measured against production: the Edge hop costs 3-12x the Express latency for
   * identical data (deliveries 943-1995ms vs 157ms; drivers 419-929ms vs 122ms),
   * and every Edge call went out twice where Express calls go out once.
   */
  const fetchDrivers = async () => {
    try {
      setLoading(true);
      const { data } = await api.get('/api/drivers');
      setDrivers(Array.isArray(data) ? data : data?.data || []);
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
      <FadeInUp>
        <PageHeader
          title="Drivers"
          subtitle="Who is on the road, and how much of today's work they have done."
          actions={
            <Button variant="primary" onClick={() => setIsModalOpen(true)}>
              <Plus size={18} />
              Add driver
            </Button>
          }
        />
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
              <EmptyState
                icon={Truck}
                title="No drivers yet"
                message="Add a driver so dispatch can assign deliveries."
                action={
                  <Button variant="primary" onClick={() => setIsModalOpen(true)}>
                    <Plus size={18} />
                    Add driver
                  </Button>
                }
              />
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
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-scrim/50 backdrop-blur-[2px] transition-all">
          <div className="bg-surface rounded-card w-full max-w-md overflow-hidden shadow-lift p-6 space-y-6 animate-in fade-in zoom-in duration-200 border border-line">
            <div className="flex flex-col items-center text-center space-y-3">
              <div className="w-12 h-12 rounded-pill bg-clay/14 text-clay flex items-center justify-center">
                <Trash2 size={24} />
              </div>
              <h2 className="text-xl font-bold text-ink">Delete driver</h2>
              <p className="text-sm text-muted leading-relaxed">
                Are you sure you want to delete driver <span className="font-semibold text-ink">{deletingDriver.name}</span>? This action cannot be undone and will delete their associated user login.
              </p>
            </div>

            <div className="flex gap-3">
              <Button
                type="button"
                onClick={() => setDeletingDriver(null)}
                disabled={deletingLoading}
                className="flex-1"
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="danger"
                onClick={handleDeleteDriver}
                disabled={deletingLoading}
                className="flex-1"
              >
                {deletingLoading ? 'Deleting...' : 'Yes, delete'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
