import React, { useRef, useState } from 'react';
import { FileText, Upload } from 'lucide-react';
import toast from 'react-hot-toast';

import api from '../../api/axios';
import { Badge, Button, Card, Field, Input } from '../ui';
import { cn } from '../../lib/cn';
import { businessDayOffset } from '../../lib/date';
import {
  REPORT_SLOTS,
  dateWarning,
  flagInfo,
  processState,
  shortDay,
  slotFor,
  slotStatus,
  summaryLine,
} from '../../lib/spruceImport';

/**
 * The morning import: the three Spruce reports, one per step.
 *
 * Each file is read the moment it is chosen, so the screen can say which
 * report it is, which day it covers and how many orders it holds before
 * anything is imported. A report in the wrong step is offered a move rather
 * than refused. Nothing is written until "Process reports".
 */
export default function SpruceImportPanel({ onClose, onImported, onShowOrder }) {
  const [dispatchDate, setDispatchDate] = useState(() => businessDayOffset(0));
  const [files, setFiles] = useState({});
  const [previews, setPreviews] = useState({});
  const [reading, setReading] = useState({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const inputs = useRef({});

  const readFile = async (slotType, file) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setFiles((current) => ({ ...current, [slotType]: file }));
      setPreviews((current) => ({ ...current, [slotType]: { error: 'Spruce reports are PDFs. Choose the PDF export.' } }));
      return;
    }

    setFiles((current) => ({ ...current, [slotType]: file }));
    setPreviews((current) => ({ ...current, [slotType]: undefined }));
    setReading((current) => ({ ...current, [slotType]: true }));
    setResult(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await api.post('/api/orders/import/reports/preview', formData);
      setPreviews((current) => ({ ...current, [slotType]: res.data }));
    } catch (err) {
      setPreviews((current) => ({
        ...current,
        [slotType]: { error: err.response?.data?.error || 'This file could not be read.' },
      }));
    } finally {
      setReading((current) => ({ ...current, [slotType]: false }));
    }
  };

  const clearSlot = (slotType) => {
    setFiles((current) => ({ ...current, [slotType]: undefined }));
    setPreviews((current) => ({ ...current, [slotType]: undefined }));
    if (inputs.current[slotType]) inputs.current[slotType].value = '';
  };

  /**
   * Moves a report to the step it belongs in. Whatever was there comes back
   * the other way, so two reports dropped into each other's steps are fixed by
   * one click, and no file chosen is ever silently dropped.
   */
  const moveSlot = (from, to) => {
    setFiles((current) => ({ ...current, [to]: current[from], [from]: current[to] }));
    setPreviews((current) => ({ ...current, [to]: current[from], [from]: current[to] }));
    if (inputs.current[from]) inputs.current[from].value = '';
  };

  const process = async () => {
    setBusy(true);
    setResult(null);
    try {
      const formData = new FormData();
      formData.append('dispatchDate', dispatchDate);
      for (const slot of REPORT_SLOTS) {
        if (slotStatus(slot.type, previews[slot.type]).kind === 'ready') formData.append(slot.type, files[slot.type]);
      }
      const res = await api.post('/api/orders/import/reports', formData);
      setResult(res.data);
      if (res.data.alreadyImported) toast('These reports were already imported. Nothing changed.');
      else toast.success(summaryLine(res.data));
      onImported?.();
    } catch (err) {
      const data = err.response?.data;
      toast.error(data?.error || 'The import failed. Nothing already imported was lost; try again.');
      // A report the server placed in another step: show it on that slot.
      if (data?.slot && data?.detectedType) {
        setPreviews((current) => ({ ...current, [data.slot]: { ...current[data.slot], reportType: data.detectedType } }));
      }
    } finally {
      setBusy(false);
    }
  };

  const state = processState(previews);

  return (
    <Card className="p-5 space-y-5 border-brand/30">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-ink">Import today&apos;s Spruce reports</h3>
          <p className="text-[13px] text-muted mt-1 max-w-2xl">
            Export the three reports from Spruce and add one to each step. They are joined on the
            order number into one order each, and the day&apos;s deliveries go to the dispatch board.
          </p>
        </div>
        <Button size="sm" onClick={onClose} disabled={busy}>Close</Button>
      </div>

      <Field label="Dispatch date" htmlFor="spruce-dispatch-date" className="max-w-[220px]">
        <Input
          id="spruce-dispatch-date"
          type="date"
          value={dispatchDate}
          onChange={(e) => setDispatchDate(e.target.value)}
          disabled={busy}
        />
      </Field>

      <div className="grid gap-3 md:grid-cols-3">
        {REPORT_SLOTS.map((slot) => {
          const preview = previews[slot.type];
          const status = reading[slot.type] ? { kind: 'reading' } : slotStatus(slot.type, preview);
          const warning = status.kind === 'ready' ? dateWarning(preview, dispatchDate) : null;

          return (
            <div
              key={slot.type}
              className={cn(
                'rounded-control border p-4 space-y-3',
                status.kind === 'ready' ? 'border-brand/40' : status.kind === 'empty' ? 'border-line border-dashed' : 'border-ochre/50'
              )}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (!busy) readFile(slot.type, e.dataTransfer.files?.[0]);
              }}
            >
              <div>
                <p className="text-[12.5px] font-medium text-muted">Step {slot.step}</p>
                <p className="text-[15px] font-semibold text-ink">{slot.label}</p>
                <p className="text-[12.5px] text-muted">Spruce: {slot.spruceTitle}</p>
              </div>

              <input
                type="file"
                accept=".pdf"
                className="hidden"
                ref={(el) => { inputs.current[slot.type] = el; }}
                onChange={(e) => readFile(slot.type, e.target.files?.[0])}
              />

              {status.kind === 'empty' && (
                <Button size="sm" onClick={() => inputs.current[slot.type]?.click()} disabled={busy}>
                  <Upload size={14} /> Choose PDF
                </Button>
              )}

              {status.kind === 'reading' && <p className="text-[13px] text-muted">Reading…</p>}

              {status.kind !== 'empty' && status.kind !== 'reading' && (
                <div className="space-y-2">
                  <p className="flex items-center gap-1.5 text-[13px] text-ink break-all">
                    <FileText size={14} className="shrink-0 text-muted" /> {files[slot.type]?.name}
                  </p>

                  {status.kind === 'ready' && (
                    <>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone="good">Ready</Badge>
                        <span className="text-[13px] text-muted tabular">
                          {preview.dateFrom ? `${shortDay(preview.dateFrom)} · ` : ''}
                          {preview.pageCount} page{preview.pageCount === 1 ? '' : 's'} ·{' '}
                          {preview.documentCount} order{preview.documentCount === 1 ? '' : 's'}
                        </span>
                      </div>
                      {preview.unreadableCount > 0 && (
                        <p className="text-[12.5px] text-ochre">
                          {preview.unreadableCount} line(s) could not be read and will be listed after import.
                        </p>
                      )}
                      {warning && <p className="text-[12.5px] text-ochre">{warning}</p>}
                    </>
                  )}

                  {status.kind === 'wrongSlot' && (
                    <>
                      <p className="text-[13px] text-ink">{status.message}</p>
                      <Button size="sm" variant="primary" onClick={() => moveSlot(slot.type, status.belongsIn)} disabled={busy}>
                        Move to Step {slotFor(status.belongsIn)?.step}
                      </Button>
                    </>
                  )}

                  {status.kind === 'error' && <p className="text-[13px] text-clay">{status.message}</p>}

                  <Button size="sm" variant="ghost" onClick={() => clearSlot(slot.type)} disabled={busy}>
                    Replace
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={process} disabled={!state.canProcess || busy}>
          {busy ? 'Importing… this can take up to a minute' : state.label}
        </Button>
        {state.reason && <p className="text-[13px] text-muted">{state.reason}</p>}
      </div>

      {result && <ImportResult result={result} onShowOrder={onShowOrder} />}
    </Card>
  );
}

function ImportResult({ result, onShowOrder }) {
  const notes = [...(result.warnings ?? []), ...(result.errors ?? [])];

  return (
    <div className="space-y-4 border-t border-line pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[15px] font-semibold text-ink">{summaryLine(result)}</p>
        {result.alreadyImported && <Badge>Already imported</Badge>}
        {result.issues?.length > 0
          ? <Badge tone="warn">{result.issues.length} need attention</Badge>
          : <Badge tone="good">Nothing needs attention</Badge>}
      </div>

      {result.issues?.length > 0 && (
        <ul className="divide-y divide-line rounded-control border border-line max-h-72 overflow-y-auto">
          {result.issues.map((issue) => (
            <li key={issue.documentNumber}>
              <button
                type="button"
                className="w-full text-left px-3 py-2 hover:bg-ink/[0.03] flex flex-wrap items-center gap-2"
                onClick={() => onShowOrder?.(issue.documentNumber)}
                title="Show this order's lines"
              >
                <span className="tabular text-[13px] font-semibold text-ink">{issue.documentNumber}</span>
                <span className="text-[13px] text-muted">{issue.customerName}</span>
                <span className="flex flex-wrap gap-1.5">
                  {issue.flags.map((flag) => (
                    <Badge key={flag} tone={flagInfo(flag).tone}>{flagInfo(flag).label}</Badge>
                  ))}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {notes.length > 0 && (
        <div className="rounded-control border border-ochre/40 bg-ochre/10 p-3">
          <p className="text-[13px] font-semibold text-ink">Details to review</p>
          <ul className="text-[13px] text-muted mt-2 space-y-1 max-h-48 overflow-y-auto">
            {notes.map((note, index) => <li key={index}>{note}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
