import React from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Users, FileText, Settings, Leaf } from 'lucide-react';

export default function Sidebar() {
  const navItems = [
    { name: 'Dashboard', path: '/dashboard', icon: LayoutDashboard },
    { name: 'Suppliers', path: '/suppliers', icon: Users },
    { name: 'Negotiated Rates', path: '/negotiated-rates', icon: FileText },
  ];

  return (
    <div className="w-64 bg-white border-r border-gray-200 flex flex-col h-full flex-shrink-0">
      <div className="h-16 flex items-center px-6 border-b border-gray-200">
        <div className="flex items-center gap-2 text-primary-600 font-bold text-xl">
          <div className="bg-primary-50 p-1.5 rounded-lg text-primary-600">
            <Leaf className="w-5 h-5" />
          </div>
          <span>CGC Admin</span>
        </div>
      </div>
      
      <div className="flex-1 overflow-y-auto py-6 px-3 space-y-1">
        <div className="px-3 mb-2 text-xs font-semibold text-gray-400 uppercase tracking-wider">
          Main Menu
        </div>
        {navItems.map((item) => (
          <NavLink
            key={item.name}
            to={item.path}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all font-medium ${
                isActive
                  ? 'bg-primary-50 text-primary-700 shadow-sm border border-primary-100'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900 border border-transparent'
              }`
            }
          >
            <item.icon className={`w-5 h-5 ${
              // Note: using basic logical behavior without breaking out to separate component
              'opacity-80'
            }`} />
            {item.name}
          </NavLink>
        ))}
      </div>
      
      <div className="p-4 border-t border-gray-200">
        <button className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-all font-medium w-full text-left">
          <Settings className="w-5 h-5" />
          Settings
        </button>
      </div>
    </div>
  );
}
