import React from 'react';
import { CheckCircle2, Circle, Clock, Package } from 'lucide-react';
import { StatusBadge } from '../ui';

const icons = {
  PLACED: <Package size={14} className="text-muted" />,
  IN_TRANSIT: <Clock size={14} className="text-ochre" />,
  DELIVERED: <CheckCircle2 size={14} className="text-brand" />,
};

export default function StatusTimeline({ history }) {
  if (!history || history.length === 0) {
    return <p className="text-[13px] text-muted">No history yet.</p>;
  }

  const sortedHistory = [...history].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return (
    <div className="space-y-4">
      {sortedHistory.map((event, idx) => (
        <div key={event.id} className="relative flex gap-3">
          {idx !== history.length - 1 && (
            <div className="absolute left-[7px] top-4 bottom-[-16px] w-px bg-line" />
          )}
          <div className="mt-1 bg-surface rounded-pill relative z-10">
            {icons[event.status] || <Circle size={14} className="text-muted" />}
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <StatusBadge status={event.status} />
              <span className="tabular text-[12.5px] text-muted">
                {new Date(event.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                {' · '}
                {new Date(event.createdAt).toLocaleDateString()}
              </span>
            </div>
            {event.notes && (
              <p className="text-[12.5px] text-muted mt-0.5">{event.notes}</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
