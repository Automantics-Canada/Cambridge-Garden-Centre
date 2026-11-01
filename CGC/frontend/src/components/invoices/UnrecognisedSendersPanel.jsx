import React, { useCallback, useEffect, useState } from 'react';
import { MailQuestion, Paperclip } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../api/axios';
import { Badge, Button, Card, Input, Select } from '../ui';
import { formatDate } from '../../lib/date';
import {
  approveFormError,
  approveOptions,
  approvePayload,
  approvedMessage,
  canManageQueue,
  describeAttachment,
  isActionable,
  reviewReasonLabel,
  senderOf,
  sortedAttachments,
  splitQueue,
} from '../../lib/emailReview';

/**
 * Emails the inbox could not read automatically, above the invoice list.
 *
 * Mail from a sender nobody has put in the supplier records used to stay in
 * Gmail with only a server log line to say so; Excel invoices were dropped.
 * Both now wait here. Approving a sender adds it to a supplier and the inbox
 * reads that sender's waiting emails on its next check (within a minute or
 * two); ignoring takes an email off the list. Hidden when nothing waits.
 */
export default function UnrecognisedSendersPanel({ role, suppliers = [], refreshKey = 0, onSupplierCreated }) {
  const [events, setEvents] = useState([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const canManage = canManageQueue(role);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/api/email-events', { params: { status: 'NEEDS_REVIEW' } });
      setEvents(data.events ?? []);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const ignore = async (event) => {
    if (!window.confirm(`Ignore "${event.subject}" from ${senderOf(event)}? It will not be read.`)) return;
    setBusyId(event.id);
    try {
      await api.post(`/api/email-events/${event.id}/ignore`);
      toast.success('Email ignored');
      await load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not ignore the email');
    } finally {
      setBusyId(null);
    }
  };

  const approve = async (event, form) => {
    setBusyId(event.id);
    try {
      const { data } = await api.post(`/api/email-events/${event.id}/approve`, approvePayload(form));
      toast.success(approvedMessage(data));
      setOpenId(null);
      if (form.supplierId === 'NEW') onSupplierCreated?.();
      await load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not approve the sender');
    } finally {
      setBusyId(null);
    }
  };

  if (loadFailed || events.length === 0) return null;
  const { senders, manual } = splitQueue(events);

  return (
    <Card className="overflow-hidden" aria-label="Unrecognised senders">
      <div className="flex flex-wrap items-center gap-3 px-5 py-4 border-b border-line">
        <MailQuestion className="h-5 w-5 text-ochre" />
        <h2 className="text-[15px] font-semibold text-ink">Unrecognised senders</h2>
        <Badge tone="warn">{events.length}</Badge>
        <p className="w-full text-[12.5px] text-muted">
          Emails the inbox did not turn into invoices.
          {canManage ? ' Approve a sender to have their emails read, or ignore an email.' : ' An owner or admin can approve or ignore them.'}
        </p>
      </div>

      <ul className="divide-y divide-line">
        {senders.map((event) => (
          <QueueRow
            key={event.id}
            event={event}
            canManage={canManage}
            busy={busyId === event.id}
            open={openId === event.id}
            onToggle={() => setOpenId(openId === event.id ? null : event.id)}
            onIgnore={() => ignore(event)}
            onApprove={(form) => approve(event, form)}
            suppliers={suppliers}
          />
        ))}
      </ul>

      {manual.length > 0 && (
        <>
          <div className="px-5 pt-4 pb-2 border-t border-line">
            <h3 className="text-[13px] font-semibold text-muted">Enter by hand</h3>
            <p className="text-[12.5px] text-muted">Known senders whose attachments the app cannot read yet. Ignore each one once it is entered.</p>
          </div>
          <ul className="divide-y divide-line">
            {manual.map((event) => (
              <QueueRow
                key={event.id}
                event={event}
                canManage={canManage}
                busy={busyId === event.id}
                open={false}
                onIgnore={() => ignore(event)}
                suppliers={suppliers}
              />
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function QueueRow({ event, canManage, busy, open, onToggle, onIgnore, onApprove, suppliers }) {
  const options = approveOptions(event);
  const actionable = isActionable(event);
  const attachments = sortedAttachments(event.attachments);

  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-ink break-all">{senderOf(event)}</span>
            {event.forwardedBy && <span className="text-[12.5px] text-muted">via {event.forwardedBy}</span>}
            {event.supplier && <Badge tone="neutral">{event.supplier.name}</Badge>}
            {event.requeuedAt && <Badge tone="good">Queued for reading</Badge>}
          </div>
          <p className="mt-0.5 text-[13.5px] text-ink truncate">{event.subject}</p>
          <p className="text-[12.5px] text-muted">
            {formatDate(event.receivedAt, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            {' · '}
            {reviewReasonLabel(event.reviewReason)}
          </p>
          {attachments.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {attachments.map((a, i) => (
                <li key={`${a.partId ?? i}`} className="flex items-center gap-1.5 text-[12.5px] text-muted">
                  <Paperclip size={12} className="flex-none" />
                  <span className="break-all">{describeAttachment(a)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {canManage && actionable && (
          <div className="flex gap-2">
            {options && (
              <Button size="sm" variant="primary" onClick={onToggle} disabled={busy}>
                {open ? 'Cancel' : 'Approve sender'}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onIgnore} disabled={busy}>
              Ignore
            </Button>
          </div>
        )}
      </div>

      {open && options && (
        <ApproveForm options={options} suppliers={suppliers} busy={busy} onSubmit={onApprove} />
      )}
    </li>
  );
}

function ApproveForm({ options, suppliers, busy, onSubmit }) {
  const [form, setForm] = useState({ supplierId: '', match: 'address', newName: '', newType: 'SUPPLIER' });
  const error = approveFormError(form, options);
  const set = (patch) => setForm((current) => ({ ...current, ...patch }));

  return (
    <form
      className="mt-3 grid gap-3 rounded-control border border-line bg-ink/[0.02] p-4 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!error) onSubmit(form);
      }}
    >
      <fieldset className="sm:col-span-2 flex flex-wrap gap-4 text-[13px] text-ink">
        <legend className="sr-only">What to approve</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="match" value="address" checked={form.match === 'address'} onChange={() => set({ match: 'address' })} />
          Only {options.address}
        </label>
        <label className={options.domainAllowed ? 'flex items-center gap-2' : 'flex items-center gap-2 text-muted'}>
          <input
            type="radio"
            name="match"
            value="domain"
            checked={form.match === 'domain'}
            disabled={!options.domainAllowed}
            onChange={() => set({ match: 'domain' })}
          />
          Everyone at {options.domain}
          {!options.domainAllowed && ' (shared mail service)'}
        </label>
      </fieldset>

      <label className="text-[12.5px] font-medium text-muted">
        Supplier
        <Select value={form.supplierId} onChange={(e) => set({ supplierId: e.target.value })} className="mt-1.5">
          <option value="">Choose…</option>
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          <option value="NEW">New supplier…</option>
        </Select>
      </label>

      {form.supplierId === 'NEW' && (
        <div className="grid gap-3 sm:grid-cols-2 sm:col-span-2">
          <label className="text-[12.5px] font-medium text-muted">
            New supplier name
            <Input value={form.newName} onChange={(e) => set({ newName: e.target.value })} className="mt-1.5" />
          </label>
          <label className="text-[12.5px] font-medium text-muted">
            Type
            <Select value={form.newType} onChange={(e) => set({ newType: e.target.value })} className="mt-1.5">
              <option value="SUPPLIER">Supplier</option>
              <option value="TRUCKING_COMPANY">Trucking company</option>
            </Select>
          </label>
        </div>
      )}

      <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" variant="primary" disabled={busy || Boolean(error)}>
          Approve and read their emails
        </Button>
        {error && <span className="text-[12.5px] text-muted">{error}</span>}
      </div>
    </form>
  );
}
