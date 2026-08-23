import React, { useState } from 'react';
import { X, Eye, EyeOff, Copy, Check, ShieldCheck } from 'lucide-react';
import api from '../../api/axios';
import { Button, Field, Input, Select } from '../ui';

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
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-scrim/50 backdrop-blur-[2px] transition-all">
      <div className="bg-surface rounded-card w-full max-w-md overflow-hidden shadow-lift border border-line animate-in fade-in zoom-in duration-200">

        {createdDriver ? (
          <div className="p-6 text-center space-y-6 animate-in fade-in duration-300">
            <div className="mx-auto w-16 h-16 bg-brand/10 text-brand rounded-pill flex items-center justify-center">
              <ShieldCheck size={36} />
            </div>

            <div className="space-y-2">
              <h2 className="text-2xl font-bold text-ink">Driver created</h2>
              <p className="text-sm text-muted">
                Save or share these login details before closing.
              </p>
            </div>

            <div className="bg-ink/[0.03] border border-line rounded-card p-4 text-left space-y-3.5">
              <div>
                <span className="text-[12.5px] font-medium text-muted block">Full name</span>
                <span className="text-sm font-semibold text-ink">{createdDriver.name}</span>
              </div>
              <div>
                <span className="text-[12.5px] font-medium text-muted block">Phone number</span>
                <span className="tabular text-sm font-semibold text-ink">{createdDriver.phone}</span>
              </div>
              {createdDriver.email ? (
                <>
                  <div>
                    <span className="text-[12.5px] font-medium text-muted block">Username / email</span>
                    <span className="text-sm font-semibold text-ink">{createdDriver.email}</span>
                  </div>
                  <div>
                    <span className="text-[12.5px] font-medium text-muted block">Password</span>
                    <span className="text-sm font-semibold text-ink bg-ink/[0.06] px-2.5 py-1 rounded-control font-mono inline-block">
                      {createdDriver.password}
                    </span>
                  </div>
                </>
              ) : (
                <div className="text-[13px] text-ink bg-ochre/15 border border-ochre/30 p-2.5 rounded-control">
                  No portal credentials created because no email was provided.
                </div>
              )}
            </div>

            <div className="flex gap-3 pt-2">
              <Button
                type="button"
                onClick={handleCopy}
                className="flex-1"
              >
                {copied ? (
                  <>
                    <Check size={16} className="text-brand" />
                    <span className="text-brand">Copied</span>
                  </>
                ) : (
                  <>
                    <Copy size={16} />
                    <span>Copy info</span>
                  </>
                )}
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={onClose}
                className="flex-1"
              >
                Close
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex justify-between items-center p-6 border-b border-line">
              <h2 className="text-xl font-bold text-ink">Add a driver</h2>
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

              <Field label="Full name" htmlFor="add-driver-name">
                <Input
                  id="add-driver-name"
                  type="text"
                  required
                  placeholder="e.g. Dave Mitchell"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                />
              </Field>

              <Field label="Phone number (10 digits)" htmlFor="add-driver-phone">
                <Input
                  id="add-driver-phone"
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

              <Field label="Email" htmlFor="add-driver-email">
                <Input
                  id="add-driver-email"
                  type="email"
                  placeholder="e.g. dave@example.com"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                />
              </Field>

              {formData.email && (
                <Field label="Password" htmlFor="add-driver-password">
                  <div className="relative">
                    <Input
                      id="add-driver-password"
                      type={showPassword ? 'text' : 'password'}
                      required={!!formData.email}
                      minLength={12}
                      className="pr-10"
                      placeholder="Set credentials password"
                      value={formData.password}
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
              )}

              <Field label="Driver type" htmlFor="add-driver-type">
                <Select
                  id="add-driver-type"
                  value={formData.type}
                  onChange={(e) => setFormData({ ...formData, type: e.target.value })}
                >
                  <option value="CGC_FLEET">CGC Fleet</option>
                  <option value="INDEPENDENT">Independent</option>
                </Select>
              </Field>

              {formData.type === 'INDEPENDENT' && (
                <Field label="Company name" htmlFor="add-driver-company">
                  <Input
                    id="add-driver-company"
                    type="text"
                    placeholder="e.g. Mitchell Trucking"
                    value={formData.companyName}
                    onChange={(e) => setFormData({ ...formData, companyName: e.target.value })}
                  />
                </Field>
              )}

              <Field label="Rate per trip ($)" htmlFor="add-driver-rate">
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted font-medium">$</span>
                  <Input
                    id="add-driver-rate"
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
                  {loading ? 'Adding...' : 'Add driver'}
                </Button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
