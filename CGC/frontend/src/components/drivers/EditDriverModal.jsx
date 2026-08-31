import React, { useState, useEffect } from 'react';
import { X, Eye, EyeOff } from 'lucide-react';
import api from '../../api/axios';
import { Button, Field, Input, Select } from '../ui';

export default function EditDriverModal({ isOpen, onClose, onSuccess, driver }) {
  const [formData, setFormData] = useState({
    name: '',
    phone: '',
    email: '',
    password: '',
    type: 'CGC_FLEET',
    companyName: '',
    ratePerDelivery: '',
    ratePerTrip: '',
    active: true
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (driver) {
      setFormData({
        name: driver.name || '',
        phone: driver.phone || '',
        email: driver.email || '',
        password: '', // blank by default, only updated if entered
        type: driver.type || 'CGC_FLEET',
        companyName: driver.companyName || '',
        ratePerDelivery: driver.ratePerDelivery || '',
        ratePerTrip: driver.ratePerTrip || '',
        active: driver.active !== undefined ? driver.active : true
      });
      setError('');
    }
  }, [driver]);

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
      const payload = {
        name: formData.name,
        phone: formData.phone,
        email: formData.email || null,
        type: formData.type,
        companyName: formData.type === 'INDEPENDENT' ? formData.companyName : null,
        ratePerDelivery: Number(formData.ratePerDelivery || 0),
        ratePerTrip: Number(formData.ratePerTrip || 0),
        active: formData.active
      };

      if (formData.password) {
        payload.password = formData.password;
      }

      await api.patch(`/api/drivers/${driver.id}`, payload);
      onSuccess();
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update driver');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen || !driver) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-scrim/50 backdrop-blur-[2px] transition-all">
      <div className="bg-surface rounded-card w-full max-w-md overflow-hidden shadow-lift border border-line animate-in fade-in zoom-in duration-200">
        <div className="flex justify-between items-center p-6 border-b border-line">
          <h2 className="text-xl font-bold text-ink">Edit driver</h2>
          <button onClick={onClose} className="text-muted hover:text-ink transition-colors p-1 hover:bg-ink/[0.05] rounded-pill">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5 h-[70vh] overflow-y-auto">
          {error && (
            <div className="bg-clay/14 border border-clay/30 text-clay p-3 rounded-control text-sm font-medium">
              {error}
            </div>
          )}

          <Field label="Full name" htmlFor="edit-driver-name">
            <Input
              id="edit-driver-name"
              type="text"
              required
              placeholder="e.g. Dave Mitchell"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            />
          </Field>

          <Field label="Phone number (10 digits)" htmlFor="edit-driver-phone">
            <Input
              id="edit-driver-phone"
              type="tel"
              required
              placeholder="e.g. 5551234567"
              value={formData.phone}
              onChange={(e) => {
                const val = e.target.value.replace(/\D/g, '');
                setFormData({ ...formData, phone: val });
              }}
              className="tabular"
            />
          </Field>

          <Field label="Email" htmlFor="edit-driver-email">
            <Input
              id="edit-driver-email"
              type="email"
              placeholder="e.g. dave@example.com"
              value={formData.email}
              onChange={(e) => setFormData({ ...formData, email: e.target.value })}
            />
          </Field>

          <Field
            label="Change password"
            hint="Leave blank to keep the current password"
            htmlFor="edit-driver-password"
          >
            <div className="relative">
              <Input
                id="edit-driver-password"
                type={showPassword ? 'text' : 'password'}
                className="pr-10"
                placeholder="Enter new password"
                value={formData.password}
                minLength={12}
                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-ink focus:outline-none"
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </Field>

          <Field label="Driver type" htmlFor="edit-driver-type">
            <Select
              id="edit-driver-type"
              value={formData.type}
              onChange={(e) => setFormData({ ...formData, type: e.target.value })}
            >
              <option value="CGC_FLEET">CGC Fleet</option>
              <option value="INDEPENDENT">Independent</option>
            </Select>
          </Field>

          {formData.type === 'INDEPENDENT' && (
            <Field label="Company name" htmlFor="edit-driver-company">
              <Input
                id="edit-driver-company"
                type="text"
                placeholder="e.g. Mitchell Trucking"
                value={formData.companyName}
                onChange={(e) => setFormData({ ...formData, companyName: e.target.value })}
              />
            </Field>
          )}

          <Field label="Rate per trip ($)" htmlFor="edit-driver-rate">
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted font-medium">$</span>
              <Input
                id="edit-driver-rate"
                type="number"
                step="0.01"
                required
                className="pl-8 tabular"
                placeholder="0.00"
                value={formData.ratePerTrip}
                onChange={(e) => setFormData({ ...formData, ratePerTrip: e.target.value })}
              />
            </div>
          </Field>

          <Field label="Status" htmlFor="active-status">
            <div className="flex items-center gap-3 bg-ink/[0.03] border border-line rounded-control p-3">
              <input
                type="checkbox"
                id="active-status"
                className="w-5 h-5 rounded border-line text-brand accent-brand cursor-pointer"
                checked={formData.active}
                onChange={(e) => setFormData({ ...formData, active: e.target.checked })}
              />
              <label htmlFor="active-status" className="text-sm font-semibold text-ink cursor-pointer select-none">
                Active (driver is visible and available for dispatch)
              </label>
            </div>
          </Field>

          <div className="pt-4 flex gap-3">
            <Button
              type="button"
              onClick={onClose}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={loading}
              className="flex-1"
            >
              {loading ? 'Saving...' : 'Save changes'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
