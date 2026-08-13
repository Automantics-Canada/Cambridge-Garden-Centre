import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Pencil, Trash2 } from 'lucide-react';
import { Badge, Button, Card, StatusBadge } from '../ui';

export default function DriverCard({ driver, onEdit, onDelete }) {
  const { name, phone, email, ratePerTrip, type, stats, currentTask } = driver;

  const initials = name.split(' ').map(n => n[0]).join('').toUpperCase();

  return (
    <motion.div
      whileHover={{ y: -5, transition: { duration: 0.2 } }}
    >
      <Card className="overflow-hidden hover:shadow-lift transition-shadow">
        <div className="p-5">
          <div className="flex items-start justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-pill bg-brand/10 text-brand flex items-center justify-center font-bold text-lg">
                {initials}
              </div>
              <div>
                <h3 className="font-bold text-ink leading-tight">{name}</h3>
                <p className="text-[12.5px] text-muted font-medium">{email || 'No email'}</p>
                <p className="tabular text-[12.5px] text-muted font-medium">{phone || 'No phone'}</p>
                <p className="tabular text-[13px] text-muted mt-1">
                  {type === 'CGC_FLEET' ? 'Fleet' : `Independent${driver.companyName ? ` (${driver.companyName})` : ''}`}
                  {' · '}${ratePerTrip}/trip
                </p>
                <div className="mt-1.5">
                  <Badge tone="good">Active</Badge>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {onEdit && (
                <button
                  onClick={() => onEdit(driver)}
                  className="text-muted hover:text-brand p-1.5 rounded-control hover:bg-ink/[0.05] transition-colors"
                  title="Edit Driver Details"
                >
                  <Pencil size={16} />
                </button>
              )}
              {onDelete && (
                <button
                  onClick={() => onDelete(driver)}
                  className="text-muted hover:text-clay p-1.5 rounded-control hover:bg-clay/10 transition-colors"
                  title="Delete Driver"
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
          </div>

          <div className="space-y-3 mb-6">
            <div className="flex justify-between text-[13px] font-medium">
              <span className="tabular text-muted">Today: {stats?.totalToday || 0} deliveries</span>
              <span className="tabular text-ink font-semibold">
                Completed: {stats?.completedToday || 0} / {stats?.totalToday || 0}
              </span>
            </div>
            <div className="relative w-full bg-ink/[0.08] rounded-pill h-2">
              <div
                className="bg-brand h-2 rounded-pill transition-all duration-700"
                style={{ width: `${stats?.progress || 0}%` }}
              />
            </div>
            <div className="flex justify-end">
              <span className="tabular text-[12.5px] font-semibold text-muted">{stats?.progress || 0}%</span>
            </div>
          </div>

          <div className="bg-ink/[0.03] rounded-control p-3 mb-4 min-h-[80px] border border-line">
            <p className="text-[12.5px] font-medium text-muted mb-2">Current</p>
            {currentTask ? (
              <div>
                <div className="flex justify-between items-center gap-2">
                  <span className="font-semibold text-ink">{currentTask.order?.spruceOrderId || 'Unknown Order'}</span>
                  <StatusBadge status={currentTask.status} />
                </div>
                <p className="text-[13px] text-muted mt-1 truncate">{currentTask.order?.customerName}</p>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full py-2">
                <p className="text-[13px] text-muted">No active task</p>
              </div>
            )}
          </div>

          <Button
            as={Link}
            to={`/dashboard/deliveries?driverId=${driver.id}`}
            className="w-full"
          >
            View deliveries
          </Button>
        </div>
      </Card>
    </motion.div>
  );
}
