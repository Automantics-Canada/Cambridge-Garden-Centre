import React, { useCallback, useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { X } from 'lucide-react';
import toast from 'react-hot-toast';

import api from '../../api/axios';
import { Badge, Button, Field, Input, ModalOverlay, Select } from '../ui';
import { getCachedSupplierOptions, loadSupplierOptions } from '../../data/routeData';
import {
  CGC_FLEET,
  HAUL_RATE_UNITS,
  carrierLabel,
  changedLoadFields,
  expectedText,
  formatHaulRate,
  loadForm,
  loadSummary,
  needsHaulRate,
  newLoadForm,
  tripText,
  validateLoadForm,
} from '../../lib/haulLoads';

/**
 * The loads line on a board row: how many, at what rate, a "No haul rate"
 * badge when dispatch still owes one, and the button that opens them.
 * Only whole orders have loads.
 */
export function HaulLoadsLine({ order, stopDriver = null, onOpen, readOnly = false }) {
  if (!order?.wholeOrder) return null;
  const summary = loadSummary(order);
  const missing = needsHaulRate(order, stopDriver);
  if (readOnly && !summary) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {missing && <Badge tone="bad">No haul rate</Badge>}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onOpen(order, stopDriver); }}
        className="text-[12.5px] font-semibold text-brand hover:underline"
        title="Loads and haul rates for this order (office only)"
      >
        {summary || 'Add load'}
      </button>
    </div>
  );
}

/**
 * Every load of one order with its carrier and haul rate (client, Oct 2026,
 * Q14). The dispatcher records them here; the trucking invoice is checked
 * against them when it comes in. A load an invoice has paid keeps its
 * figures: only its note can change. Office only; a driver never sees this.
 *
 * @param order the board order
 * @param stopDriver the driver whose run the order is on, if any
 */
export default function HaulLoads({ order, stopDriver = null, readOnly = false, onClose, onChanged }) {
  const userId = useSelector((state) => state.auth?.user?.id);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [carriers, setCarriers] = useState([]);
  const [suppliers, setSuppliers] = useState(() => getCachedSupplierOptions(userId) ?? []);
  // The load being edited, 'new' for a new one, or null for none.
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await api.get(`/api/dispatch/orders/${order.id}/loads`);
      setData(res.data);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || 'The loads could not be read.');
    }
  }, [order.id]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (readOnly) return undefined;
    let cancelled = false;
    api.get('/api/suppliers/options', { params: { type: 'TRUCKING_COMPANY' } })
      .then((res) => { if (!cancelled) setCarriers(Array.isArray(res.data) ? res.data : []); })
      .catch((err) => console.error('Carrier list failed', err));
    if (userId) {
      loadSupplierOptions(userId)
        .then((list) => { if (!cancelled) setSuppliers(list); })
        .catch((err) => console.error('Supplier list failed', err));
    }
    return () => { cancelled = true; };
  }, [readOnly, userId]);

  const loads = data?.loads ?? [];
  const locked = saving || readOnly;

  const startNew = () => {
    setEditing('new');
    setForm(newLoadForm(stopDriver, carriers));
    setErrors({});
  };
  const startEdit = (load) => {
    setEditing(load);
    setForm(loadForm(load));
    setErrors({});
  };
  const stopEditing = () => {
    setEditing(null);
    setForm(null);
    setErrors({});
  };
  const setField = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  /** Runs one change, then reads the loads again and redraws the board. */
  const run = async (request, success) => {
    setSaving(true);
    try {
      const res = await request();
      if (success) toast.success(typeof success === 'function' ? success(res.data) : success);
      await refresh();
      onChanged?.();
      return true;
    } catch (err) {
      toast.error(err.response?.data?.error || 'Nothing was changed; try again.');
      await refresh();
      return false;
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    const { errors: found, body } = validateLoadForm(form);
    setErrors(found);
    if (!body) return;
    const isNew = editing === 'new';
    if (!isNew) {
      const changes = changedLoadFields(editing, body);
      if (Object.keys(changes).length === 0) {
        stopEditing();
        return;
      }
      if (await run(() => api.patch(`/api/dispatch/loads/${editing.id}`, changes), `Load ${editing.sequence} saved`)) stopEditing();
      return;
    }
    // An empty "Loaded at" leaves the server to use the order's pit.
    const { sourceSupplierId, ...rest } = body;
    const request = sourceSupplierId ? body : rest;
    if (await run(() => api.post(`/api/dispatch/orders/${order.id}/loads`, request), (created) => `Load ${created.sequence} added`)) {
      stopEditing();
    }
  };

  const remove = (load) => {
    if (!window.confirm(`Remove load ${load.sequence} of ${order.spruceOrderId}?`)) return;
    run(() => api.delete(`/api/dispatch/loads/${load.id}`), `Load ${load.sequence} removed`);
    if (editing?.id === load.id) stopEditing();
  };

  const copyToTrip = (load) => {
    run(
      () => api.post(`/api/dispatch/loads/${load.id}/copy-rate-to-trip`),
      (result) => `Trip ${result.tripRef}: ${result.updated} load${result.updated === 1 ? '' : 's'} updated` +
        (result.skipped ? `, ${result.skipped} already paid` : ''),
    );
  };

  const paid = editing && editing !== 'new' && editing.claimed;

  return (
    <ModalOverlay>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Loads for ${order.spruceOrderId}`}
        className="bg-surface rounded-card w-full max-w-2xl max-h-[90vh] flex flex-col shadow-lift border border-line mx-4"
      >
        <div className="flex items-start justify-between gap-4 px-6 py-5 border-b border-line">
          <div>
            <h2 className="text-lg font-bold text-ink tabular">Loads for {order.spruceOrderId}</h2>
            <p className="text-[13px] text-muted mt-0.5">
              The haul rate for each load, checked against the trucking invoice. Drivers never see this.
            </p>
          </div>
          <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close">
            <X size={18} />
          </Button>
        </div>

        <div className="overflow-y-auto px-6 py-5 space-y-4">
          {error && <p className="text-[13px] text-clay">{error}</p>}
          {!data && !error && <p className="text-[13px] text-muted">Loading…</p>}
          {data && loads.length === 0 && (
            <p className="text-[13px] text-muted">
              No loads yet.{needsHaulRate(order, stopDriver) && ' This order is on a brokered truck: add its load and rate.'}
            </p>
          )}

          {loads.length > 0 && (
            <ul className="rounded-control border border-line divide-y divide-line">
              {loads.map((load) => (
                <li key={load.id} className="p-3 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-bold text-ink">Load {load.sequence}</span>
                    <span className="text-[13px] text-ink">{carrierLabel(load)}</span>
                    <span className="text-[13px] font-semibold text-ink tabular">
                      {formatHaulRate(load.rate, load.rateUnit) || <span className="text-muted font-normal">no rate</span>}
                    </span>
                    {load.claimed && <Badge tone="good">Paid</Badge>}
                    {!load.claimed && load.rate === null && (load.carrierSupplierId || load.driverType === 'INDEPENDENT') && (
                      <Badge tone="bad">No haul rate</Badge>
                    )}
                  </div>
                  <p className="text-[12.5px] text-muted">
                    {[
                      expectedText(load),
                      load.sourceName && `From ${load.sourceName}`,
                      load.ticketNumber && `Ticket ${load.ticketNumber}`,
                      load.notes,
                    ].filter(Boolean).join(' · ')}
                  </p>
                  {load.tripRef && (
                    <p className="text-[12.5px] text-muted">
                      {tripText(load)}
                      {load.trip && !load.trip.sameRate && <span className="text-clay font-semibold"> · rates differ</span>}
                    </p>
                  )}
                  {!readOnly && (
                    <div className="flex flex-wrap gap-3 pt-1">
                      <button type="button" className="text-[12.5px] font-semibold text-brand hover:underline disabled:opacity-50" onClick={() => startEdit(load)} disabled={locked}>
                        {load.claimed ? 'Edit note' : 'Edit'}
                      </button>
                      {load.tripRef && load.rate !== null && load.trip && !load.trip.sameRate && !load.claimed && (
                        <button type="button" className="text-[12.5px] font-semibold text-brand hover:underline disabled:opacity-50" onClick={() => copyToTrip(load)} disabled={locked}>
                          Use this rate for the whole trip
                        </button>
                      )}
                      {!load.claimed && (
                        <button type="button" className="text-[12.5px] font-semibold text-clay hover:underline disabled:opacity-50" onClick={() => remove(load)} disabled={locked}>
                          Remove
                        </button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {form && !readOnly && (
            <div className="rounded-control border border-line p-4 space-y-3">
              <p className="text-[13px] font-bold text-ink">
                {editing === 'new' ? 'New load' : `Load ${editing.sequence}`}
              </p>
              {paid && <p className="text-[12.5px] text-muted">Paid on a trucking invoice: only the note can change.</p>}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field htmlFor="haul-carrier" label="Carrier">
                  <Select id="haul-carrier" value={form.carrierSupplierId} onChange={(e) => setField('carrierSupplierId', e.target.value)} disabled={locked || paid}>
                    <option value={CGC_FLEET}>CGC fleet</option>
                    {/* A carrier since deactivated still shows on its load. */}
                    {editing !== 'new' && editing.carrierSupplierId && !carriers.some((c) => c.id === editing.carrierSupplierId) && (
                      <option value={editing.carrierSupplierId}>{editing.carrierName ?? 'Carrier'}</option>
                    )}
                    {carriers.map((carrier) => <option key={carrier.id} value={carrier.id}>{carrier.name}</option>)}
                  </Select>
                </Field>
                <Field htmlFor="haul-source" label="Loaded at" hint={editing === 'new' ? 'Blank: the order’s pit.' : undefined}>
                  <Select id="haul-source" value={form.sourceSupplierId} onChange={(e) => setField('sourceSupplierId', e.target.value)} disabled={locked || paid}>
                    <option value="">{editing === 'new' ? 'Order’s pit' : 'Not set'}</option>
                    {editing !== 'new' && editing.sourceSupplierId && !suppliers.some((s) => s.id === editing.sourceSupplierId) && (
                      <option value={editing.sourceSupplierId}>{editing.sourceName ?? 'Supplier'}</option>
                    )}
                    {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
                  </Select>
                </Field>
                <Field htmlFor="haul-rate" label="Rate" error={errors.rate || errors.rateUnit}>
                  <div className="flex gap-2">
                    <Input id="haul-rate" className="tabular" inputMode="decimal" placeholder="95.00" value={form.rate} onChange={(e) => setField('rate', e.target.value)} disabled={locked || paid} />
                    <Select aria-label="Rate unit" className="w-36" value={form.rateUnit} onChange={(e) => setField('rateUnit', e.target.value)} disabled={locked || paid}>
                      {HAUL_RATE_UNITS.map((unit) => <option key={unit.value} value={unit.value}>{unit.label}</option>)}
                    </Select>
                  </div>
                </Field>
                <Field htmlFor="haul-quantity" label="Expected loads, hours or tonnes" error={errors.quantity}>
                  <Input id="haul-quantity" className="tabular" inputMode="decimal" value={form.quantity} onChange={(e) => setField('quantity', e.target.value)} disabled={locked || paid} />
                </Field>
                <Field htmlFor="haul-trip" label="Trip ref" hint="Same ref on each order one truck collects together." error={errors.tripRef}>
                  <Input id="haul-trip" placeholder="T-1103-A" value={form.tripRef} onChange={(e) => setField('tripRef', e.target.value)} disabled={locked || paid} />
                </Field>
                <Field htmlFor="haul-ticket" label="Ticket #" error={errors.ticketNumber}>
                  <Input id="haul-ticket" className="tabular" value={form.ticketNumber} onChange={(e) => setField('ticketNumber', e.target.value)} disabled={locked || paid} />
                </Field>
              </div>
              <Field htmlFor="haul-notes" label="Note" error={errors.notes}>
                <Input id="haul-notes" value={form.notes} onChange={(e) => setField('notes', e.target.value)} disabled={locked} />
              </Field>
              <div className="flex justify-end gap-3">
                <Button onClick={stopEditing} disabled={saving}>Cancel</Button>
                <Button variant="primary" onClick={save} disabled={locked}>{saving ? 'Saving…' : 'Save load'}</Button>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 px-6 py-4 border-t border-line">
          {!readOnly && !form && !data?.quote && (
            <Button className="mr-auto" onClick={startNew} disabled={!data || saving}>Add load</Button>
          )}
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </ModalOverlay>
  );
}
