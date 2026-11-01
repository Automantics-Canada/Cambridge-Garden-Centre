import React, { useCallback, useEffect, useState } from 'react';
import { Hash, Plus, X } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../api/axios';
import { Badge, Button, Input } from '../ui';
import { describeUnmapped, mappedMessage, normaliseVendorCode, sortVendorCodes } from '../../lib/spruceVendors';

/**
 * The Spruce vendor codes this supplier bills under.
 *
 * Spruce reports name vendors by code, so an order line's supplier is found
 * only through this list. Codes the import saw but could not map are offered
 * below, one click to map here.
 */
export default function SpruceVendorCodes({ supplierId }) {
  const [codes, setCodes] = useState([]);
  const [unmapped, setUnmapped] = useState([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [mine, open] = await Promise.all([
        api.get('/api/spruce-vendors', { params: { supplierId } }),
        api.get('/api/spruce-vendors/unmapped'),
      ]);
      setCodes(sortVendorCodes(mine.data));
      setUnmapped(open.data);
    } catch {
      toast.error('Could not load the vendor codes');
    }
  }, [supplierId]);

  useEffect(() => {
    load();
  }, [load]);

  const add = async (raw) => {
    const code = normaliseVendorCode(raw);
    if (!code) {
      toast.error('Enter the code exactly as Spruce prints it, e.g. EXAMPLEV01');
      return;
    }
    setBusy(true);
    try {
      const { data } = await api.post('/api/spruce-vendors', { supplierId, code });
      toast.success(mappedMessage(data));
      setDraft('');
      await load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not add the code');
    } finally {
      setBusy(false);
    }
  };

  const retire = async (code) => {
    if (!window.confirm(`Remove ${code}? Lines already imported keep this supplier; later imports will not use the code.`)) return;
    setBusy(true);
    try {
      await api.delete(`/api/spruce-vendors/${encodeURIComponent(code)}`, { params: { supplierId } });
      toast.success(`${code} removed`);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not remove the code');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-5" onClick={(e) => e.stopPropagation()}>
      <h4 className="text-[13px] font-semibold text-muted flex items-center gap-2 mb-2">
        <Hash size={14} className="text-brand" /> Spruce vendor codes
      </h4>
      <p className="text-[12.5px] text-muted mb-3">
        The codes Spruce prints for this supplier on its reports. Order lines with these codes are linked to this supplier.
      </p>

      <div className="flex flex-wrap gap-2 mb-3">
        {codes.length === 0 && <span className="text-sm text-muted">No codes yet.</span>}
        {codes.map((entry) => (
          <span
            key={entry.code}
            className="inline-flex items-center gap-1.5 rounded-pill border border-line bg-surface px-3 py-1 text-[13px] font-mono text-ink"
          >
            {entry.code}
            {entry.active ? (
              <button
                type="button"
                onClick={() => retire(entry.code)}
                disabled={busy}
                className="text-muted hover:text-clay"
                title={`Remove ${entry.code}`}
                aria-label={`Remove ${entry.code}`}
              >
                <X size={13} />
              </button>
            ) : (
              <Badge tone="neutral">Removed</Badge>
            )}
          </span>
        ))}
      </div>

      <form
        className="flex gap-2 max-w-md"
        onSubmit={(e) => {
          e.preventDefault();
          add(draft);
        }}
      >
        <Input
          aria-label="New Spruce vendor code"
          placeholder="e.g. EXAMPLEV01"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="font-mono uppercase"
        />
        <Button type="submit" size="sm" disabled={busy || !draft.trim()}>
          <Plus size={14} /> Add code
        </Button>
      </form>

      {unmapped.length > 0 && (
        <div className="mt-4">
          <p className="text-[12.5px] font-semibold text-muted mb-2">Codes on imported orders with no supplier yet</p>
          <ul className="space-y-1.5">
            {unmapped.slice(0, 10).map((entry) => (
              <li key={entry.code} className="flex items-center justify-between gap-3 text-[13px] text-ink">
                <span className="font-mono">{describeUnmapped(entry)}</span>
                <Button size="sm" variant="ghost" onClick={() => add(entry.code)} disabled={busy}>
                  Map here
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
