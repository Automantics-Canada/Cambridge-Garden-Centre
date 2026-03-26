import React from 'react';
import { Link } from 'react-router-dom';
import { LayoutDashboard } from 'lucide-react';

export default function Navbar() {
  return (
    <nav className="bg-white border-b border-green-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between h-16">
          <div className="flex items-center">
            <Link to="/" className="flex items-center gap-2">
              <div className="w-8 h-8 bg-green-600 rounded-lg flex items-center justify-center">
                <span className="text-white font-bold text-xl">C</span>
              </div>
              <span className="text-xl font-bold text-green-800">Cambridge Garden Centre</span>
            </Link>
          </div>
          <div className="flex items-center">
            <Link
              to="/dashboard/orders"
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700 shadow-sm transition-colors duration-200"
            >
              <LayoutDashboard className="w-4 h-4 mr-2" />
              Dashboard
            </Link>
          </div>
        </div>
      </div>
    </nav>
  );
}
