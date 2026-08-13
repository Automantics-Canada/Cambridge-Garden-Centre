import React, { useEffect, useState } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import {
  LayoutDashboard, ShoppingCart, Truck, MapPin, UserSquare,
  Briefcase, Calculator, LogOut, Package, FileText, Menu, X,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { logout } from '../store/authSlice';
import LogoutModal from '../components/LogoutModal';
import { ThemeToggle } from '../components/ui';
import { cn } from '../lib/cn';

const NAV_GROUPS = [
  {
    title: 'Overview',
    items: [
      { name: 'Dashboard', path: '/dashboard', icon: LayoutDashboard, end: true },
    ],
  },
  {
    title: 'Orders',
    items: [
      { name: 'Verification Desk', path: '/dashboard/verification-desk', icon: FileText },
      { name: 'Tickets', path: '/dashboard/tickets', icon: Briefcase },
      { name: 'Orders', path: '/dashboard/orders', icon: ShoppingCart },
      { name: 'Invoices', path: '/dashboard/invoices', icon: Calculator },
    ],
  },
  {
    title: 'Fleet & delivery',
    items: [
      { name: 'Drivers', path: '/dashboard/drivers', icon: UserSquare },
      { name: 'Dispatch board', path: '/dashboard/dispatch', icon: MapPin },
      { name: 'Deliveries', path: '/dashboard/deliveries', icon: Truck },
    ],
  },
  {
    title: 'Resources',
    items: [
      { name: 'Suppliers', path: '/dashboard/supplier', icon: Truck },
      { name: 'Products', path: '/dashboard/products', icon: Package },
    ],
  },
];

function NavItem({ item, onNavigate }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.path}
      end={item.end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-pill px-4 py-2.5 text-[13.5px]',
          'transition-colors duration-150',
          isActive
            ? 'bg-brand text-white font-semibold'
            : 'text-rail-ink font-medium hover:bg-brand/10'
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon
            size={18}
            strokeWidth={isActive ? 2.2 : 1.75}
            className="flex-none"
          />
          <span className="truncate">{item.name}</span>
        </>
      )}
    </NavLink>
  );
}

export default function DashboardLayout() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showLogoutModal, setShowLogoutModal] = useState(false);
  const location = useLocation();
  const dispatch = useDispatch();
  const user = useSelector((state) => state.auth.user);

  // Moving to another page should never leave the mobile drawer hanging open.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  const sidebar = (
    <div className="flex flex-col h-full bg-rail border-r border-line">
      {/* Brand */}
      <div className="flex items-center gap-3 px-6 pt-7 pb-8">
        <div className="w-9 h-9 rounded-control bg-brand flex-none" />
        <div className="min-w-0">
          <p className="text-[15px] font-bold text-rail-ink leading-tight">
            Cambridge
          </p>
          <p className="text-[11px] text-muted leading-tight">Garden Centre</p>
        </div>
        <button
          type="button"
          onClick={() => setDrawerOpen(false)}
          className="ml-auto lg:hidden text-muted hover:text-ink p-1"
          aria-label="Close menu"
        >
          <X size={20} />
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto custom-scrollbar px-3 pb-4 space-y-6">
        {NAV_GROUPS.map((group) => (
          <div key={group.title}>
            <p className="px-4 pb-2 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-muted/80">
              {group.title}
            </p>
            <div className="space-y-1">
              {group.items.map((item) => (
                <NavItem key={item.path} item={item} />
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Signed-in user */}
      <div className="border-t border-line px-4 py-4 flex items-center gap-3">
        <div className="w-9 h-9 rounded-pill bg-brand/15 text-brand flex items-center justify-center font-bold text-[13px] flex-none">
          {user?.name ? user.name.charAt(0).toUpperCase() : 'U'}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-ink truncate">
            {user?.name || 'User'}
          </p>
          <p className="text-[11.5px] text-muted truncate">
            {user?.role?.replace(/_/g, ' ').toLowerCase() || 'staff'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowLogoutModal(true)}
          title="Sign out"
          aria-label="Sign out"
          className="w-9 h-9 rounded-pill flex items-center justify-center text-muted hover:text-clay hover:bg-clay/10 transition-colors flex-none"
        >
          <LogOut size={17} strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      {/* Sidebar — fixed on desktop */}
      <aside className="hidden lg:block w-[248px] flex-none">{sidebar}</aside>

      {/* Sidebar — drawer on mobile */}
      <AnimatePresence>
        {drawerOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setDrawerOpen(false)}
              className="fixed inset-0 z-40 bg-ink/40 lg:hidden"
            />
            <motion.aside
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              transition={{ type: 'tween', duration: 0.2, ease: 'easeOut' }}
              className="fixed inset-y-0 left-0 z-50 w-[264px] lg:hidden"
            >
              {sidebar}
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* Main column */}
      <div className="flex-1 flex flex-col h-screen overflow-hidden">
        {/* Slim bar: menu button on mobile, theme toggle always */}
        <div className="flex items-center gap-2 px-4 lg:px-8 pt-4 flex-none">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="lg:hidden w-10 h-10 rounded-pill flex items-center justify-center text-muted hover:text-ink hover:bg-ink/[0.05] transition-colors"
            aria-label="Open menu"
          >
            <Menu size={20} />
          </button>
          <ThemeToggle className="ml-auto" />
        </div>

        <main className="flex-1 overflow-auto custom-scrollbar px-4 lg:px-8 pb-12 pt-2">
          <AnimatePresence mode="wait">
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      <LogoutModal
        isOpen={showLogoutModal}
        onClose={() => setShowLogoutModal(false)}
        onConfirm={() => dispatch(logout())}
      />
    </div>
  );
}
