import React from 'react';

const statusColors = {
  PLACED: 'bg-blue-50 text-blue-700 border-blue-200',
  IN_TRANSIT: 'bg-violet-50 text-violet-700 border-violet-200',
  DELIVERED: 'bg-emerald-50 text-emerald-700 border-emerald-200'
};

export default function StatusBadge({ status, className = "" }) {
  return (
    <span className={`px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider border ${statusColors[status] || 'bg-gray-100 text-gray-700'} ${className}`}>
      {status?.replace(/_/g, ' ') || 'UNKNOWN'}
    </span>
  );
}
