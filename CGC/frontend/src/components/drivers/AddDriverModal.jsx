import React, { useState } from 'react';
import { X } from 'lucide-react';
import api from '../../api/axios';

export default function AddDriverModal({ isOpen, onClose, onSuccess }) {
  const [formData, setFormData] = useState({
    name: '',
    phone: '',
    email: '',
    password: '',
    type: 'CGC_FLEET',
    companyName: '',
    ratePerDelivery: '',
    ratePerTrip: ''
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    
    try {
      const payload = { ...formData };
      if (payload.type !== 'INDEPENDENT') {
        payload.companyName = undefined;
      }
      await api.post('/api/drivers', payload);
      onSuccess();
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add driver');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-[2px] transition-all">
      <div className="bg-white rounded-2xl w-full max-w-md overflow-hidden shadow-2xl animate-in fade-in zoom-in duration-200">
        <div className="flex justify-between items-center p-6 border-b border-gray-100 bg-gray-50/50">
          <h2 className="text-xl font-bold text-gray-900">Add New Driver</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors p-1 hover:bg-gray-100 rounded-full">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5 h-[70vh] overflow-y-auto">
          {error && (
            <div className="bg-red-50 border border-red-100 text-red-600 p-3 rounded-xl text-sm font-medium">
              {error}
            </div>
          )}
          
          <div className="space-y-1.5">
            <label className="text-xs font-bold text-gray-500 uppercase tracking-wider ml-1">Full Name</label>
            <input
              type="text"
              required
              className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:border-[#2D6A4F] focus:ring-4 focus:ring-[#2D6A4F]/10 outline-none transition-all placeholder:text-gray-300"
              placeholder="e.g. Dave Mitchell"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold text-gray-500 uppercase tracking-wider ml-1">Phone Number</label>
            <input
              type="tel"
              required
              className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:border-[#2D6A4F] focus:ring-4 focus:ring-[#2D6A4F]/10 outline-none transition-all placeholder:text-gray-300"
              placeholder="e.g. +1 555-0123"
              value={formData.phone}
              onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold text-gray-500 uppercase tracking-wider ml-1">Email</label>
            <input
              type="email"
              className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:border-[#2D6A4F] focus:ring-4 focus:ring-[#2D6A4F]/10 outline-none transition-all placeholder:text-gray-300"
              placeholder="e.g. dave@example.com"
              value={formData.email}
              onChange={(e) => setFormData({ ...formData, email: e.target.value })}
            />
          </div>

          {formData.email && (
            <div className="space-y-1.5 animate-in fade-in slide-in-from-top-2 duration-200">
              <label className="text-xs font-bold text-gray-500 uppercase tracking-wider ml-1">Password</label>
              <input
                type="password"
                required={!!formData.email}
                className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:border-[#2D6A4F] focus:ring-4 focus:ring-[#2D6A4F]/10 outline-none transition-all placeholder:text-gray-300"
                placeholder="Set credentials password"
                value={formData.password}
                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-bold text-gray-500 uppercase tracking-wider ml-1">Driver Type</label>
            <select
              className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:border-[#2D6A4F] focus:ring-4 focus:ring-[#2D6A4F]/10 outline-none transition-all bg-white"
              value={formData.type}
              onChange={(e) => setFormData({ ...formData, type: e.target.value })}
            >
              <option value="CGC_FLEET">CGC Fleet</option>
              <option value="INDEPENDENT">Independent</option>
            </select>
          </div>

          {formData.type === 'INDEPENDENT' && (
            <div className="space-y-1.5 animate-in fade-in slide-in-from-top-2 duration-200">
              <label className="text-xs font-bold text-gray-500 uppercase tracking-wider ml-1">Company Name</label>
              <input
                type="text"
                className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:border-[#2D6A4F] focus:ring-4 focus:ring-[#2D6A4F]/10 outline-none transition-all placeholder:text-gray-300"
                placeholder="e.g. Mitchell Trucking"
                value={formData.companyName}
                onChange={(e) => setFormData({ ...formData, companyName: e.target.value })}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-bold text-gray-500 uppercase tracking-wider ml-1">Rate per Trip ($)</label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 font-medium">$</span>
              <input
                type="number"
                step="0.01"
                required
                className="w-full pl-8 pr-4 py-3 rounded-xl border border-gray-200 focus:border-[#2D6A4F] focus:ring-4 focus:ring-[#2D6A4F]/10 outline-none transition-all placeholder:text-gray-300"
                placeholder="0.00"
                value={formData.ratePerTrip}
                onChange={(e) => setFormData({ ...formData, ratePerTrip: e.target.value })}
              />
            </div>
          </div>

          <div className="pt-4 flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-3 rounded-xl border border-gray-200 text-gray-700 font-bold hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 px-4 py-3 rounded-xl bg-[#2D6A4F] text-white font-bold hover:bg-[#1B4332] transition-colors shadow-lg shadow-[#2D6A4F]/20 disabled:opacity-50"
            >
              {loading ? 'Adding...' : 'Add Driver'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
