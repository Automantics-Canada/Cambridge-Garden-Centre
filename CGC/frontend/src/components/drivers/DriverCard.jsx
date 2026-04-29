import React from 'react';
import { Link } from 'react-router-dom';

export default function DriverCard({ driver }) {
  const { name, phone, ratePerDelivery, stats, currentTask } = driver;
  
  const initials = name.split(' ').map(n => n[0]).join('').toUpperCase();

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden hover:shadow-md transition-shadow">
      <div className="p-5">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-green-100 text-[#2D6A4F] flex items-center justify-center font-bold text-lg">
              {initials}
            </div>
            <div>
              <h3 className="font-bold text-gray-900">{name}</h3>
              <p className="text-xs text-gray-500">Fleet • ${ratePerDelivery}/delivery</p>
              <div className="flex items-center gap-1 mt-1">
                <div className="w-2 h-2 rounded-full bg-green-500"></div>
                <span className="text-[10px] font-semibold text-green-600 uppercase tracking-wider">Active</span>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-3 mb-6">
          <div className="flex justify-between text-xs font-medium">
            <span className="text-gray-500 font-semibold">Today: {stats?.totalToday || 0} deliveries</span>
            <span className="text-gray-900 font-bold">Completed: {stats?.completedToday || 0} / {stats?.totalToday || 0}</span>
          </div>
          <div className="relative w-full bg-gray-100 rounded-full h-2">
            <div 
              className="bg-[#2D6A4F] h-2 rounded-full transition-all duration-700" 
              style={{ width: `${stats?.progress || 0}%` }}
            ></div>
          </div>
          <div className="flex justify-end">
            <span className="text-[10px] font-bold text-gray-400">{stats?.progress || 0}%</span>
          </div>
        </div>

        <div className="bg-gray-50 rounded-lg p-3 mb-4 min-h-[80px] border border-gray-100">
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Current</p>
          {currentTask ? (
            <div>
              <div className="flex justify-between items-center">
                <span className="font-bold text-gray-900">{currentTask.spruceOrderId}</span>
                <span className="text-[10px] font-bold text-orange-600 bg-orange-50 border border-orange-100 px-2 py-0.5 rounded-full uppercase tracking-tight">
                  {currentTask.deliveryStatus.replace('_', ' ')}
                </span>
              </div>
              <p className="text-xs text-gray-500 mt-1 truncate">{currentTask.customerName}</p>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full py-2">
              <p className="text-xs text-gray-400 italic">No active task</p>
            </div>
          )}
        </div>

        <Link 
          to={`/dashboard/orders?driverId=${driver.id}`}
          className="w-full flex items-center justify-center gap-2 border border-gray-200 text-gray-700 py-2.5 rounded-lg text-sm font-semibold hover:bg-gray-50 transition-colors"
        >
          View Deliveries
        </Link>
      </div>
    </div>
  );
}
