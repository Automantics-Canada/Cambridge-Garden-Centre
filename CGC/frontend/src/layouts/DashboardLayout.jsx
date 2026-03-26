import React from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import { LayoutDashboard, Receipt, Ticket, LogOut } from 'lucide-react';

const navigation = [
  { name: 'Orders', href: '/dashboard/orders', icon: LayoutDashboard },
  { name: 'Invoices', href: '/dashboard/invoices', icon: Receipt },
  { name: 'Tickets', href: '/dashboard/tickets', icon: Ticket },
];

function classNames(...classes) {
  return classes.filter(Boolean).join(' ');
}

export default function DashboardLayout() {
  const location = useLocation();

  return (
    <div className="min-h-screen bg-gray-50 flex">
      {/* Sidebar */}
      <div className="w-64 bg-green-900 border-r border-green-800 hidden md:flex md:flex-col md:fixed md:inset-y-0 text-white">
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex items-center h-16 flex-shrink-0 px-4 bg-green-950">
            <Link to="/" className="flex items-center gap-2">
              <div className="w-8 h-8 bg-green-600 rounded-lg flex items-center justify-center">
                <span className="text-white font-bold text-xl">C</span>
              </div>
              <span className="text-lg font-bold truncate">Admin Panel</span>
            </Link>
          </div>
          <div className="flex-1 flex flex-col overflow-y-auto">
            <nav className="flex-1 px-2 py-4 space-y-1">
              {navigation.map((item) => {
                const isActive = location.pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.name}
                    to={item.href}
                    className={classNames(
                      isActive ? 'bg-green-800 text-white' : 'text-green-100 hover:bg-green-800 hover:text-white',
                      'group flex items-center px-2 py-2 text-sm font-medium rounded-md transition-colors'
                    )}
                  >
                    <item.icon
                      className={classNames(
                        isActive ? 'text-white' : 'text-green-300 group-hover:text-white',
                        'mr-3 flex-shrink-0 h-5 w-5'
                      )}
                      aria-hidden="true"
                    />
                    {item.name}
                  </Link>
                );
              })}
            </nav>
          </div>
          <div className="flex-shrink-0 flex border-t border-green-800 p-4">
            <Link to="/" className="flex items-center text-sm font-medium text-green-100 hover:text-white">
              <LogOut className="mr-3 h-5 w-5 text-green-300" />
              Back to Website
            </Link>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="md:pl-64 flex flex-col flex-1 w-full">
        {/* Mobile header */}
        <div className="sticky top-0 z-10 md:hidden pl-1 pt-1 sm:pl-3 sm:pt-3 bg-green-900">
          <div className="flex items-center justify-between p-3 text-white">
            <span className="text-lg font-bold">Admin Panel</span>
            <Link to="/" className="text-sm font-medium hover:text-green-200">Exit</Link>
          </div>
        </div>

        <main className="flex-1 p-6">
          <div className="max-w-7xl mx-auto">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
