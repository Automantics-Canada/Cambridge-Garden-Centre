import React, { useState } from 'react';
import { X, Eye, EyeOff, Copy, Check, ShieldCheck } from 'lucide-react';
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
  const [showPassword, setShowPassword] = useState(false);
  const [createdDriver, setCreatedDriver] = useState(null);
  const [copied, setCopied] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    // Phone Number Validation: must be exactly 10 digits
    const digitsOnly = formData.phone.replace(/\D/g, '');
    if (digitsOnly.length !== 10) {
      setError('Phone number must be exactly 10 digits.');
      setLoading(false);
      return;
    }
    
    try {
      const payload = { ...formData };
      if (payload.type !== 'INDEPENDENT') {
        payload.companyName = undefined;
      }
      await api.post('/api/drivers', payload);
      
      // Save created details to display on success screen
      setCreatedDriver({
        name: formData.name,
        email: formData.email,
        password: formData.password,
        phone: formData.phone
      });
      onSuccess();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add driver');
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    if (!createdDriver) return;
    const textToCopy = `Driver Name: ${createdDriver.name}\nPhone: ${createdDriver.phone}\n${createdDriver.email ? `Email/Username: ${createdDriver.email}\nPassword: ${createdDriver.password}` : 'No driver portal login credentials.'}`;
    navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-[2px] transition-all">
      <div className="bg-white rounded-2xl w-full max-w-md overflow-hidden shadow-2xl animate-in fade-in zoom-in duration-200">
        
        {createdDriver ? (
          // Success Screen
          <div className="p-6 text-center space-y-6 animate-in fade-in duration-300">
            <div className="mx-auto w-16 h-16 bg-green-50 text-[#2D6A4F] rounded-full flex items-center justify-center">
              <ShieldCheck size={36} />
            </div>
            
            <div className="space-y-2">
              <h2 className="text-2xl font-bold text-gray-900">Driver Created Successfully!</h2>
              <p className="text-sm text-gray-500">
                Please make sure to save or share these login details before closing.
              </p>
            </div>

            <div className="bg-gray-50 border border-gray-100 rounded-2xl p-4 text-left space-y-3.5 shadow-inner">
              <div>
                <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider block">Full Name</span>
                <span className="text-sm font-semibold text-gray-900">{createdDriver.name}</span>
              </div>
              <div>
                <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider block">Phone Number</span>
                <span className="text-sm font-semibold text-gray-900">{createdDriver.phone}</span>
              </div>
              {createdDriver.email ? (
                <>
                  <div>
                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider block">Username / Email</span>
                    <span className="text-sm font-semibold text-gray-900">{createdDriver.email}</span>
                  </div>
                  <div>
                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider block">Password</span>
                    <span className="text-sm font-bold text-gray-900 bg-gray-200/60 px-2.5 py-1 rounded-md font-mono inline-block">
                      {createdDriver.password}
                    </span>
                  </div>
                </>
              ) : (
                <div className="text-xs text-amber-600 bg-amber-50/50 border border-amber-100 p-2.5 rounded-lg font-medium">
                  No portal credentials created because no email was provided.
                </div>
              )}
            </div>

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={handleCopy}
                className="flex-1 flex items-center justify-center gap-2 border border-gray-200 text-gray-700 py-3 rounded-xl font-bold hover:bg-gray-50 transition-colors"
              >
                {copied ? (
                  <>
                    <Check size={16} className="text-green-600" />
                    <span className="text-green-600">Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy size={16} />
                    <span>Copy Info</span>
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-3 rounded-xl bg-[#2D6A4F] text-white font-bold hover:bg-[#1B4332] transition-colors shadow-lg shadow-[#2D6A4F]/20"
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          // Form Screen
          <>
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
                <label className="text-xs font-bold text-gray-500 uppercase tracking-wider ml-1">Phone Number (10 Digits)</label>
                <input
                  type="tel"
                  required
                  className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:border-[#2D6A4F] focus:ring-4 focus:ring-[#2D6A4F]/10 outline-none transition-all placeholder:text-gray-300"
                  placeholder="e.g. 5551234567"
                  value={formData.phone}
                  onChange={(e) => {
                    const val = e.target.value.replace(/\D/g, '');
                    setFormData({ ...formData, phone: val });
                  }}
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
                  <div className="relative">
                    <input
                      type={showPassword ? "text" : "password"}
                      required={!!formData.email}
                      className="w-full pl-4 pr-10 py-3 rounded-xl border border-gray-200 focus:border-[#2D6A4F] focus:ring-4 focus:ring-[#2D6A4F]/10 outline-none transition-all placeholder:text-gray-300"
                      placeholder="Set credentials password"
                      value={formData.password}
                      onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 focus:outline-none"
                    >
                      {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
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
          </>
        )}
      </div>
    </div>
  );
}
