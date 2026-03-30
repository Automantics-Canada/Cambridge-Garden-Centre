import React from 'react';
import { useSelector } from 'react-redux';

export default function Dashboard() {
  const user = useSelector((state) => state.auth.user);
  const currentDate = new Date();
  const dateOptions = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-gray-900 tracking-tight flex items-center gap-2">
          Good morning, {user?.name?.split(' ')[0] || 'User'} <span className="text-2xl">👋</span>
        </h1>
        <p className="text-gray-500 text-sm mt-1">{currentDate.toLocaleDateString('en-US', dateOptions)}</p>
      </div>

      <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm min-h-[300px] flex items-center justify-center">
         <div className="text-gray-500 text-center">
            <h2 className="text-xl font-semibold mb-2">Welcome to your Operations Dashboard</h2>
            <p>Select an option from the sidebar to get started.</p>
         </div>
      </div>
    </div>
  );
}
