import React, { useState } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { 
  LayoutDashboard, ShoppingCart, Truck, Users, 
  MapPin, UserSquare, Briefcase, Calculator, 
  BarChart, Settings, Menu, Search, Eye, Bell, LogOut, ChevronLeft, ChevronRight
} from 'lucide-react';
import { logout } from '../store/authSlice';
import clsx from 'clsx';

export default function DashboardLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const location = useLocation();
  const dispatch = useDispatch();
  const user = useSelector(state => state.auth.user);

  const navGroups = [
    {
      title: 'MAIN',
      items: [
        { name: 'Dashboard', path: '/dashboard', icon: <LayoutDashboard size={20} /> },
        { name: 'Tickets', path: '/dashboard/tickets', icon: <Briefcase size={20} /> },
        { name: 'Orders', path: '/dashboard/orders', icon: <ShoppingCart size={20} /> },
        { name: 'Suppliers', path: '/dashboard/suppliers', icon: <Truck size={20} /> },
        { name: 'Invoices', path: '/dashboard/invoices', icon: <Calculator size={20} /> },
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
            <div>
              <h1 className="text-2xl font-bold tracking-tight">CGC</h1>
              <p className="text-xs text-green-300">Operations</p>
            </div>
          ) : (
            <h1 className="text-2xl font-bold text-center">C</h1>
          )}
        </div>

        <nav className="flex-1 overflow-y-auto px-3 space-y-6">
          {navGroups.map((group, idx) => (
            <div key={idx}>
              {sidebarOpen && <div className="text-xs font-semibold text-green-500 mb-2 uppercase tracking-wider pl-3">{group.title}</div>}
              <ul className="space-y-1">
                {group.items.map((item) => {
                  const isActive = location.pathname === item.path;
                  return (
                    <li key={item.name}>
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
                    </li>
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
              {user?.name?.substring(0,2).toUpperCase() || "SK"}
            </div>
            {sidebarOpen && (
              <div className="flex-1 overflow-hidden">
                <div className="text-sm font-semibold truncate">{user?.name || "Sarah K."}</div>
                <div className="text-xs text-green-300 truncate">{user?.role || "Admin"}</div>
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col h-screen overflow-hidden">
        {/* Top Navbar */}
        <header className="bg-white border-b border-gray-200 h-16 flex items-center justify-between px-6 flex-shrink-0 z-10 transition-all">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-xl font-semibold text-gray-800">
              <Menu size={20} className="text-gray-500 md:hidden" />
              Dashboard
            </div>
          </div>
          
          <div className="flex-1 max-w-xl mx-8 hidden md:block">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
              <input 
                type="text" 
                placeholder="Search orders, customers..." 
                className="w-full bg-gray-50 border border-gray-200 rounded-md pl-10 pr-4 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#1D5333]"
              />
            </div>
          </div>

          <div className="flex items-center gap-4 text-sm">
            <button className="hidden sm:flex items-center gap-2 text-gray-600 border border-gray-300 rounded-md px-3 py-1.5 hover:bg-gray-50 transition-colors">
              <Eye size={16} /> Driver View
            </button>
            <div className="relative">
              <Bell className="text-gray-500 hover:text-gray-700 cursor-pointer" size={20} />
              <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center text-[10px] font-bold">3</div>
            </div>
             <div className="flex items-center gap-2 border-l pl-4 ml-2">
                <div className="w-8 h-8 rounded-full bg-[#1B4332] text-white flex items-center justify-center font-bold text-sm">
                  {user?.name?.substring(0,2).toUpperCase() || "SK"}
                </div>
                <div className="hidden sm:block text-right leading-tight">
                  <div className="font-medium text-gray-800 text-sm">{user?.name || "Sarah K."}</div>
                  <div className="text-xs text-gray-500">{user?.role || "Admin"}</div>
                </div>
                <button onClick={() => dispatch(logout())} className="ml-2 text-gray-400 hover:text-red-500 transition-colors" title="Logout">
                  <LogOut size={18} />
                </button>
             </div>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-auto bg-[#F9FBF9] p-6 lg:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
