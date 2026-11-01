import React, { useMemo, useRef, useState } from 'react';
import { Download, FileSpreadsheet, Upload } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../api/axios';
import { Badge, Button, Card, Field, Select } from '../ui';
import {
  actionLabel,
  buildTemplateCsv,
  isPriceListFile,
  previewRows,
  priceListFileName,
  ratesToCsv,
  summarisePreview,
} from '../../lib/priceList';

function downloadCsv(text, fileName) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const TON_CHOICES = [
  { value: 'TONNE', label: 'Metric tonne (1,000 kg)' },
  { value: 'SHORT_TON', label: 'Short ton (2,000 lb)' },
];

/**
 * Load a supplier's price list: choose the supplier and file, check it, read
 * the preview, then save. Nothing is written until Save, and Save writes every
 * row or none.
 */
export default function PriceListImport({ suppliers, onSaved }) {
  const [supplierId, setSupplierId] = useState('');
  const [file, setFile] = useState(null);
  const [tonMeans, setTonMeans] = useState('');
  const [preview, setPreview] = useState(null);
  const [onlyChanges, setOnlyChanges] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef(null);

  const supplier = suppliers.find((s) => s.id === supplierId);
  const rows = useMemo(() => previewRows(preview, { onlyChanges }), [preview, onlyChanges]);
  const changes = preview ? preview.plan.counts.CREATE + preview.plan.counts.SUPERSEDE + preview.plan.counts.CORRECT : 0;

  const reset = () => {
    setFile(null);
    setPreview(null);
    setTonMeans('');
    if (fileInput.current) fileInput.current.value = '';
  };

  const formFor = (extra = {}) => {
    const form = new FormData();
    form.append('file', file);
    const ton = extra.tonMeans ?? tonMeans;
    if (ton) form.append('tonMeans', ton);
    for (const [key, value] of Object.entries(extra)) if (key !== 'tonMeans') form.append(key, value);
    return form;
  };

  const check = async (nextTon = tonMeans) => {
    if (!supplierId || !file) {
      toast.error('Choose a supplier and a file first');
      return;
    }
    setBusy(true);
    try {
      const { data } = await api.post(`/api/suppliers/${supplierId}/rates/import/preview`, formFor({ tonMeans: nextTon }));
      setPreview(data);
    } catch (err) {
      setPreview(null);
      toast.error(err.response?.data?.error || 'Could not read the file');
    } finally {
      setBusy(false);
    }
  };

  const chooseTon = (value) => {
    setTonMeans(value);
    check(value);
  };

  const save = async () => {
    if (!preview?.plan?.canCommit) return;
    setBusy(true);
    try {
      const { data } = await api.post(
        `/api/suppliers/${supplierId}/rates/import`,
        formFor({ token: preview.token })
      );
      const { CREATE = 0, SUPERSEDE = 0, CORRECT = 0 } = data.counts ?? {};
      toast.success(`Saved ${CREATE + SUPERSEDE + CORRECT} rate change(s) for ${data.supplier?.name ?? 'the supplier'}. Open invoices are being re-checked.`);
      reset();
      onSaved?.();
    } catch (err) {
      // The server sends the up-to-date preview when the plan changed, or a
      // row turned out to be wrong; show that rather than the old one.
      if (err.response?.data?.preview) setPreview(err.response.data.preview);
      toast.error(err.response?.data?.error || 'Nothing was saved');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-bold text-ink flex items-center gap-2">
            <FileSpreadsheet className="w-4 h-4 text-brand" /> Import a price list
          </h3>
          <p className="text-[13px] text-muted mt-1 max-w-2xl">
            Fill the template in Excel and save it as .xlsx or CSV UTF-8. Dates are YYYY-MM-DD, prices are before HST.
            A new price closes the old one the day before; the old price stays on record for older invoices.
            Nothing is saved until you check the preview and press Save.
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => downloadCsv(buildTemplateCsv(), 'price-list-template.csv')}>
            <Download className="w-4 h-4" /> Template
          </Button>
          <Button
            size="sm"
            disabled={!supplier}
            onClick={() => downloadCsv(ratesToCsv(supplier?.negotiatedRates), priceListFileName(supplier?.name, 'rates'))}
            title="This supplier's current rates, in the template's format"
          >
            <Download className="w-4 h-4" /> Current rates
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] items-end">
        <Field label="Supplier" htmlFor="pricelist-supplier">
          <Select
            id="pricelist-supplier"
            value={supplierId}
            onChange={(e) => {
              setSupplierId(e.target.value);
              setPreview(null);
            }}
          >
            <option value="">Select supplier</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="File (.csv or .xlsx)" htmlFor="pricelist-file">
          <input
            id="pricelist-file"
            ref={fileInput}
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="block w-full text-[13px] text-muted file:mr-3 file:rounded-pill file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-ink"
            onChange={(e) => {
              const chosen = e.target.files?.[0] ?? null;
              if (chosen && !isPriceListFile(chosen)) {
                toast.error('Choose a .csv or .xlsx file. An old .xls must be saved as .xlsx first.');
                e.target.value = '';
                return;
              }
              setFile(chosen);
              setPreview(null);
              setTonMeans('');
            }}
          />
        </Field>
        <Button variant="secondary" onClick={() => check()} disabled={busy || !supplierId || !file}>
          <Upload className="w-4 h-4" /> Check file
        </Button>
      </div>

      {preview && (
        <div className="space-y-3">
          <p className={preview.plan.canCommit ? 'text-sm text-ink' : 'text-sm text-clay font-medium'}>
            {summarisePreview(preview)}
          </p>
          {preview.file?.otherSheets?.length > 0 && (
            <p className="text-[12.5px] text-muted">
              Read the sheet “{preview.file.sheet}”. Other sheets were not read: {preview.file.otherSheets.join(', ')}.
            </p>
          )}
          {preview.plan.ignoredColumns?.length > 0 && (
            <p className="text-[12.5px] text-muted">Columns not in the template were ignored: {preview.plan.ignoredColumns.join(', ')}.</p>
          )}

          {(preview.plan.needsTonChoice || tonMeans) && (
            <fieldset className="rounded-control border border-ochre/40 bg-ochre/10 p-3">
              <legend className="px-1 text-[13px] font-semibold text-ink">This file says “ton”. Which ton are these prices for?</legend>
              <div className="flex flex-wrap gap-4 mt-1">
                {TON_CHOICES.map((choice) => (
                  <label key={choice.value} className="flex items-center gap-2 text-sm text-ink">
                    <input
                      type="radio"
                      name="pricelist-ton"
                      value={choice.value}
                      checked={tonMeans === choice.value}
                      onChange={() => chooseTon(choice.value)}
                      disabled={busy}
                    />
                    {choice.label}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {preview.plan.rows.length > 0 && (
            <>
              <label className="flex items-center gap-2 text-[13px] text-muted">
                <input type="checkbox" checked={onlyChanges} onChange={(e) => setOnlyChanges(e.target.checked)} />
                Hide rows with no change
              </label>
              <div className="overflow-x-auto max-h-[420px] border border-line rounded-control">
                <table className="min-w-full divide-y divide-line text-sm">
                  <thead className="bg-ink/[0.03] sticky top-0">
                    <tr>
                      {['Row', 'Product', 'Unit', 'Rate', 'From', 'To', 'What happens'].map((h) => (
                        <th key={h} className="px-3 py-2 text-left text-[12.5px] font-semibold text-muted">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="bg-surface divide-y divide-line">
                    {rows.map((row) => {
                      const label = actionLabel(row.action);
                      return (
                        <tr key={row.rowNumber} className={row.action === 'ERROR' ? 'bg-clay/[0.05]' : undefined}>
                          <td className="tabular px-3 py-2 text-muted">{row.rowNumber}</td>
                          <td className="px-3 py-2 text-ink">{row.value?.productName ?? row.input.product}</td>
                          <td className="px-3 py-2 text-muted">{row.value?.unit ?? row.input.unit}</td>
                          <td className="tabular px-3 py-2 text-ink">
                            {row.value ? `$${Number(row.value.rate).toFixed(2)}` : row.input.rate}
                          </td>
                          <td className="tabular px-3 py-2 text-muted">{row.value?.effectiveFrom ?? row.input.effective_from}</td>
                          <td className="tabular px-3 py-2 text-muted">{row.value ? (row.value.effectiveTo ?? '') : row.input.effective_to}</td>
                          <td className="px-3 py-2">
                            <Badge tone={label.tone}>{label.label}</Badge>
                            <span className="ml-2 text-[13px] text-muted">{row.message}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <div className="flex gap-3">
            <Button variant="primary" onClick={save} disabled={busy || !preview.plan.canCommit}>
              Save {changes} change{changes === 1 ? '' : 's'}
            </Button>
            <Button onClick={reset} disabled={busy}>Cancel</Button>
          </div>
        </div>
      )}
    </Card>
  );
}
