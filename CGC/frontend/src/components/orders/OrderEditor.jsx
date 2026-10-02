import React, { useCallback, useEffect, useState } from 'react';
import { RotateCcw, X } from 'lucide-react';
import toast from 'react-hot-toast';

import api from '../../api/axios';
import { Badge, Button, Field, Input, ModalOverlay, Select, Textarea } from '../ui';
import { flagInfo } from '../../lib/spruceImport';
import {
  DELIVERY_TYPE_OPTIONS,
  ORDER_FIELDS,
  editRequest,
  formFromOrder,
  overrideFor,
  spruceText,
} from '../../lib/orderEditor';

/**
 * Correct one Spruce order: fill in what the reports left out, fix what they
 * got wrong. Corrections survive the reports being uploaded again; each
 * corrected field is marked, says what Spruce has, and can be reset to it.
 *
 * Prices and the order number are not here: Spruce owns them.
 *
 * @param orderRef the order's id or its Spruce number, e.g. 2608-712600
 * @param readOnly show the order without letting it change, for a past day
 */
export default function OrderEditor({ orderRef, onClose, onSaved, readOnly = false }) {
  const [order, setOrder] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const locked = saving || readOnly;

  const show = useCallback((loaded) => {
    setOrder(loaded);
    setForm(formFromOrder(loaded));
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.get(`/api/orders/documents/${encodeURIComponent(orderRef)}`)
      .then((res) => { if (!cancelled) show(res.data); })
      .catch((err) => { if (!cancelled) setError(err.response?.data?.error || 'This order could not be opened.'); });
    return () => { cancelled = true; };
  }, [orderRef, show]);

  const setField = (key, value) => setForm((current) => ({ ...current, fields: { ...current.fields, [key]: value } }));
  const setLine = (id, key, value) =>
    setForm((current) => ({ ...current, lines: { ...current.lines, [id]: { ...current.lines[id], [key]: value } } }));

  const save = async () => {
    const request = editRequest(order, form);
    if (!request) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      const res = await api.patch(`/api/orders/documents/${order.id}`, request);
      show(res.data.order);
      toast.success(`Saved ${order.documentNumber}`);
      onSaved?.(res.data.order);
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'The change could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const reset = async (field, lineId = null) => {
    setSaving(true);
    try {
      const res = await api.post(`/api/orders/documents/${order.id}/reset`, { field, lineId });
      show(res.data.order);
      toast.success('Reset to the Spruce value');
      onSaved?.(res.data.order);
    } catch (err) {
      toast.error(err.response?.data?.error || 'The reset failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalOverlay>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={order ? `${readOnly ? 'View' : 'Edit'} order ${order.documentNumber}` : `${readOnly ? 'View' : 'Edit'} order`}
        className="bg-surface rounded-card w-full max-w-2xl max-h-[90vh] flex flex-col shadow-lift border border-line mx-4"
      >
        <div className="flex items-start justify-between gap-4 px-6 py-5 border-b border-line">
          <div>
            <h2 className="text-lg font-bold text-ink tabular">{order?.documentNumber ?? 'Order'}</h2>
            <p className="text-[13px] text-muted mt-0.5">
              {readOnly
                ? 'This day is history, so the order can only be viewed here.'
                : 'Changes here are kept when the Spruce reports are uploaded again.'}
            </p>
            {order?.flags?.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {order.flags.map((flag) => <Badge key={flag} tone={flagInfo(flag).tone}>{flagInfo(flag).label}</Badge>)}
              </div>
            )}
          </div>
          <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close">
            <X size={18} />
          </Button>
        </div>

        <div className="overflow-y-auto px-6 py-5 space-y-5">
          {error && <p className="text-[13px] text-clay">{error}</p>}
          {!order && !error && <p className="text-[13px] text-muted">Loading…</p>}

          {order && form && (
            <>
              {ORDER_FIELDS.map(({ key, label, multiline, type }) => {
                const override = overrideFor(order, key);
                const id = `order-edit-${key}`;
                const control = type === 'deliveryType' ? (
                  <Select id={id} aria-label={label} value={form.fields[key]} onChange={(e) => setField(key, e.target.value)} disabled={locked}>
                    {DELIVERY_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </Select>
                ) : multiline ? (
                  <Textarea id={id} aria-label={label} rows={3} value={form.fields[key]} onChange={(e) => setField(key, e.target.value)} disabled={locked} />
                ) : (
                  <Input
                    id={id}
                    // The label holds an "Edited" badge too; name the field plainly.
                    aria-label={label}
                    type={type === 'date' ? 'date' : 'text'}
                    className={type === 'date' ? 'tabular w-48' : undefined}
                    value={form.fields[key]}
                    onChange={(e) => setField(key, e.target.value)}
                    disabled={locked}
                  />
                );

                return (
                  <Field key={key} htmlFor={id} label={<FieldLabel label={label} override={override} />}>
                    {control}
                    {!readOnly && key === 'shippingAddress' && !form.fields.shippingAddress && order.addressSuggestion && (
                      <button
                        type="button"
                        className="self-start text-[12.5px] font-semibold text-brand hover:underline"
                        onClick={() => setField('shippingAddress', order.addressSuggestion.address)}
                      >
                        Use this account&apos;s last address: {order.addressSuggestion.address}
                      </button>
                    )}
                    <SpruceNote override={override} field={key} onReset={() => reset(key)} disabled={saving} readOnly={readOnly} />
                  </Field>
                );
              })}

              <Field htmlFor="order-edit-notes" label="Note for the driver" hint="Ours, not from Spruce.">
                <Textarea
                  id="order-edit-notes"
                  rows={2}
                  value={form.dispatcherNotes}
                  onChange={(e) => setForm((current) => ({ ...current, dispatcherNotes: e.target.value }))}
                  disabled={locked}
                />
              </Field>

              <div className="space-y-2">
                <p className="text-[13px] font-medium text-ink">Items</p>
                <div className="rounded-control border border-line divide-y divide-line">
                  {order.lines.map((line) => {
                    const productOverride = overrideFor(order, 'product', line.id);
                    const quantityOverride = overrideFor(order, 'quantity', line.id);
                    return (
                      <div key={line.id} className="p-3 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="tabular text-[12.5px] text-muted">{line.spruceItemNumber}</span>
                          {(productOverride || quantityOverride) && <Badge tone="warn">Edited</Badge>}
                        </div>
                        <div className="flex gap-2">
                          <Input
                            aria-label={`Description of ${line.spruceItemNumber ?? 'item'}`}
                            value={form.lines[line.id]?.product ?? ''}
                            onChange={(e) => setLine(line.id, 'product', e.target.value)}
                            disabled={locked}
                          />
                          <Input
                            aria-label={`Quantity of ${line.spruceItemNumber ?? 'item'}`}
                            className="tabular w-28"
                            inputMode="decimal"
                            value={form.lines[line.id]?.quantity ?? ''}
                            onChange={(e) => setLine(line.id, 'quantity', e.target.value)}
                            disabled={locked}
                          />
                          <span className="self-center text-[13px] text-muted w-12">{line.unit}</span>
                        </div>
                        <SpruceNote override={productOverride} field="product" onReset={() => reset('product', line.id)} disabled={saving} readOnly={readOnly} />
                        <SpruceNote override={quantityOverride} field="quantity" onReset={() => reset('quantity', line.id)} disabled={saving} readOnly={readOnly} />
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="flex justify-end gap-3 px-6 py-4 border-t border-line">
          {readOnly ? (
            <Button onClick={onClose}>Close</Button>
          ) : (
            <>
              <Button onClick={onClose} disabled={saving}>Cancel</Button>
              <Button variant="primary" onClick={save} disabled={!order || saving}>
                {saving ? 'Saving…' : 'Save changes'}
              </Button>
            </>
          )}
        </div>
      </div>
    </ModalOverlay>
  );
}

function FieldLabel({ label, override }) {
  return (
    <span className="inline-flex items-center gap-2">
      {label}
      {override && <Badge tone="warn">Edited</Badge>}
    </span>
  );
}

/** What Spruce says beside a correction, and the way back to it. */
function SpruceNote({ override, field, onReset, disabled, readOnly }) {
  if (!override) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
      <span className={override.spruceChanged ? 'text-ochre font-semibold' : 'text-muted'}>
        {override.spruceChanged ? 'Spruce changed this since your edit, to ' : 'Spruce has '}
        {spruceText(override, field)}.
      </span>
      {!readOnly && (
        <button
          type="button"
          className="inline-flex items-center gap-1 font-semibold text-brand hover:underline disabled:opacity-50"
          onClick={onReset}
          disabled={disabled}
        >
          <RotateCcw size={12} /> Reset to Spruce value
        </button>
      )}
    </div>
  );
}
