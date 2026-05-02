import React from 'react';

const statusColors = {
  UNASSIGNED: 'bg-gray-100 text-gray-700 border-gray-200',
  PLACED: 'bg-blue-50 text-blue-700 border-blue-200',
  OUT_FOR_DELIVERY: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  IN_TRANSIT: 'bg-amber-50 text-amber-700 border-amber-200',
  DELIVERED: 'bg-green-50 text-green-700 border-green-200',
  ON_HOLD: 'bg-orange-50 text-orange-700 border-orange-200',
  DELAYED: 'bg-red-50 text-red-700 border-red-200',
  CANCELLED: 'bg-gray-100 text-gray-500 border-gray-300',
};

export default function StatusBadge({ status, className = "" }) {
  return (
    <span className={`px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider border ${statusColors[status] || 'bg-gray-100 text-gray-700'} ${className}`}>
      {status?.replace(/_/g, ' ') || 'UNKNOWN'}
    </span>
  );
}
