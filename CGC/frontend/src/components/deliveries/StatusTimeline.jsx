import React from 'react';
import { CheckCircle2, Circle, Clock, Package } from 'lucide-react';

const icons = {
  PLACED: <Package size={14} className="text-blue-500" />,
  IN_TRANSIT: <Clock size={14} className="text-violet-500" />,
  DELIVERED: <CheckCircle2 size={14} className="text-emerald-500" />
};

export default function StatusTimeline({ history }) {
  if (!history || history.length === 0) return <p className="text-xs text-gray-400 italic">No history available</p>;

  return (
    <div className="space-y-4">
      {history.map((event, idx) => (
        <div key={event.id} className="relative flex gap-3">
          {idx !== history.length - 1 && (
            <div className="absolute left-[7px] top-4 bottom-[-16px] w-[1px] bg-gray-200" />
          )}
          <div className="mt-1 bg-white rounded-full relative z-10">
            {icons[event.status] || <Circle size={14} className="text-gray-300" />}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-gray-900">{event.status.replace(/_/g, ' ')}</span>
              <span className="text-[10px] text-gray-400">
                {new Date(event.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} • {new Date(event.createdAt).toLocaleDateString()}
              </span>
            </div>
            {event.notes && <p className="text-[10px] text-gray-500 mt-0.5">{event.notes}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}
