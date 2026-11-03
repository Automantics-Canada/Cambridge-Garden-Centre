import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../api/axios', () => ({ default: api }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import UnrecognisedSendersPanel from './UnrecognisedSendersPanel';

afterEach(cleanup);

const queue = {
  events: [
    {
      id: 'e1', status: 'NEEDS_REVIEW', reviewReason: 'UNKNOWN_SENDER', subject: 'Invoice 7001',
      originalFrom: 'owner.op@gmail.com', fromAddress: 'owner.op@gmail.com', forwardedBy: 'ap@garden-centre.example',
      receivedAt: '2026-11-01T14:00:00Z', requeuedAt: null,
      attachments: [{ name: 'inv-7001.pdf', size: 51_200, action: 'held', reason: 'waiting for the sender to be approved', partId: '1' }],
    },
    {
      id: 'e2', status: 'NEEDS_REVIEW', reviewReason: 'SPREADSHEET', subject: 'Statement',
      originalFrom: 'billing@stone.example', fromAddress: 'billing@stone.example', supplier: { id: 's1', name: 'Example Stone' },
      receivedAt: '2026-11-01T15:00:00Z', requeuedAt: null,
      attachments: [{ name: 'loads.xls', size: 2048, action: 'review', reason: 'old Excel format (.xls): ask the supplier for PDF or .xlsx', partId: '1' }],
    },
  ],
  counts: { NEEDS_REVIEW: 2, IGNORED: 0 },
};

beforeEach(() => {
  api.get.mockReset().mockResolvedValue({ data: queue });
  api.post.mockReset().mockResolvedValue({ data: { added: { value: 'owner.op@gmail.com' }, supplier: { name: 'Example Haulage' }, requeued: 1 } });
});

describe('unrecognised senders panel', () => {
  it('lists sender, subject and attachments, with no actions for AP staff', async () => {
    render(<UnrecognisedSendersPanel role="AP_USER" suppliers={[]} />);
    expect(await screen.findByText('owner.op@gmail.com')).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith('/api/email-events', { params: { status: 'NEEDS_REVIEW' } });
    expect(screen.getByText('Invoice 7001')).toBeTruthy();
    expect(screen.getByText(/inv-7001\.pdf · 50 KB/)).toBeTruthy();
    expect(screen.getByText(/loads\.xls · 2 KB · old Excel format \(\.xls\): ask the supplier for PDF or \.xlsx/)).toBeTruthy();
    expect(screen.getByText('Enter by hand')).toBeTruthy();
    expect(screen.queryByText('Approve sender')).toBeNull();
    expect(screen.queryByText('Ignore')).toBeNull();
  });

  it('an owner approves a free-mail sender by address onto a chosen supplier', async () => {
    render(<UnrecognisedSendersPanel role="OWNER" suppliers={[{ id: 's9', name: 'Example Haulage' }]} />);
    fireEvent.click(await screen.findByText('Approve sender'));

    const domain = screen.getByLabelText(/Everyone at gmail\.com/);
    expect(domain.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Supplier/), { target: { value: 's9' } });
    fireEvent.click(screen.getByText('Approve and read their emails'));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/email-events/e1/approve', { match: 'address', supplierId: 's9' }));
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('renders nothing when the queue is empty', async () => {
    api.get.mockResolvedValue({ data: { events: [], counts: { NEEDS_REVIEW: 0, IGNORED: 0 } } });
    const { container } = render(<UnrecognisedSendersPanel role="OWNER" />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
