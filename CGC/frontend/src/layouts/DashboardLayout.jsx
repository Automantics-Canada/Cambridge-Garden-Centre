import React, { useState } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { 
  LayoutDashboard, ShoppingCart, Truck, Users, 
  MapPin, UserSquare, Briefcase, Calculator, 
  BarChart, Settings, Menu, Search, Eye, Bell, LogOut, ChevronLeft, ChevronRight, Package,
  File
} from 'lucide-react';
import { logout } from '../store/authSlice';
import clsx from 'clsx';

import { motion, AnimatePresence } from 'framer-motion';

export default function DashboardLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const location = useLocation();
  const dispatch = useDispatch();
  const user = useSelector(state => state.auth.user);

  const navGroups = [
    {
      title: 'Overview',
      items: [
        { name: 'Dashboard', path: '/dashboard', icon: <LayoutDashboard size={20} /> },
      ]
    },
    {
      title: 'Order Management',
      items: [
        { name: 'Verification Desk', path: '/dashboard/verification-desk', icon: <File size={20} /> },
        { name: 'Tickets', path: '/dashboard/tickets', icon: <Briefcase size={20} /> },
        { name: 'Orders', path: '/dashboard/orders', icon: <ShoppingCart size={20} /> },
        { name: 'Invoices', path: '/dashboard/invoices', icon: <Calculator size={20} /> },
      ]
    },
    {
      title: 'Fleet & Delivery',
      items: [
        { name: 'Drivers', path: '/dashboard/drivers', icon: <UserSquare size={20} /> },
        { name: 'Dispatch Board', path: '/dashboard/dispatch', icon: <MapPin size={20} /> },
        { name: 'Deliveries', path: '/dashboard/deliveries', icon: <Truck size={20} /> },
      ]
    },
    {
      title: 'Resources',
      items: [
        { name: 'Suppliers', path: '/dashboard/supplier', icon: <Truck size={20} /> },
        { name: 'Products', path: '/dashboard/products', icon: <Package size={20} /> },
      ]
    }
  ];

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden font-sans">
      {/* Sidebar */}
      <aside className={clsx(
        "bg-[#1B4332] text-white flex flex-col transition-all duration-300 relative",
        sidebarOpen ? "w-64" : "w-16"
      )}>
        {/* Toggle Button */}
        <button 
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="absolute -right-3 top-6 bg-white text-[#1B4332] rounded-full p-1 shadow-md border border-gray-200 z-10"
        >
          {sidebarOpen ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
        </button>

        <div className="p-4 mb-4 mt-2">
          {sidebarOpen ? (
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
            >
              <h1 className="text-2xl font-bold tracking-tight">CGC</h1>
              <p className="text-xs text-green-300">Operations</p>
            </motion.div>
          ) : (
            <h1 className="text-2xl font-bold text-center">C</h1>
          )}
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
          {navGroups.map((group, idx) => (
            <div key={idx} className={clsx(idx > 0 && "pt-4")}>
              {sidebarOpen && <div className="text-[10px] font-bold text-green-400/60 mb-2 uppercase tracking-[0.1em] px-3">{group.title}</div>}
              <ul className="space-y-1">
                {group.items.map((item, i) => {
                  const isActive = location.pathname === item.path;
                  return (
                    <motion.li 
                      key={item.name}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.05 }}
                    >
                      <Link
                        to={item.path}
                        className={clsx(
                          "flex items-center rounded-lg px-3 py-2.5 transition-colors",
                          isActive ? "bg-[#2D6A4F] text-white" : "text-green-100 hover:bg-[#2D6A4F]/50",
                          !sidebarOpen && "justify-center"
                        )}
                        title={!sidebarOpen ? item.name : undefined}
                      >
                        {item.icon}
                        {sidebarOpen && <span className="ml-3 font-medium">{item.name}</span>}
                      </Link>
                    </motion.li>
                  )
                })}
              </ul>
            </div>
          ))}
        </nav>

        {/* User Profile Area */}
        <div className="p-4 border-t border-[#2D6A4F] mt-auto">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-[#2D6A4F] flex items-center justify-center font-bold text-sm flex-shrink-0">
              {user?.name ? user.name.substring(0, 2).toUpperCase() : "U"}
            </div>
            {sidebarOpen && (
              <div className="flex-1 overflow-hidden">
                <div className="text-sm font-semibold truncate text-white">{user?.name || 'User'}</div>
                <div className="text-xs text-green-300 truncate font-medium uppercase tracking-wider">
                  {user?.role?.replace('_', ' ') || 'Staff'}
                </div>
              </div>
            )}
            <button 
              onClick={() => dispatch(logout())} 
              className={clsx(
                "text-green-300 hover:text-white transition-colors",
                !sidebarOpen && "hidden"
              )}
              title="Logout"
            >
              <LogOut size={18} />
            </button>
          </div>
          {!sidebarOpen && (
            <button 
              onClick={() => dispatch(logout())} 
              className="mt-4 w-full flex justify-center text-green-300 hover:text-white transition-colors"
              title="Logout"
            >
              <LogOut size={18} />
            </button>
          )}
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col h-screen overflow-hidden">
        {/* Page Content */}
        <main className="flex-1 overflow-auto bg-[#F9FBF9] p-6 lg:p-8">
          <AnimatePresence mode="wait">
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}
