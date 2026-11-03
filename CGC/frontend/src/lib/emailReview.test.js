import { describe, expect, it } from 'vitest';
import {
  approveFormError,
  approveOptions,
  approvePayload,
  approvedMessage,
  approveSupplierChoices,
  canManageQueue,
  describeAttachment,
  failureText,
  isActionable,
  reviewReasonLabel,
  senderOf,
  sortedAttachments,
  splitQueue,
} from './emailReview';

const event = (over = {}) => ({
  id: 'e1',
  status: 'NEEDS_REVIEW',
  reviewReason: 'UNKNOWN_SENDER',
  originalFrom: 'Billing@New-Supplier.example',
  fromAddress: 'billing@new-supplier.example',
  requeuedAt: null,
  ...over,
});

describe('unrecognised senders panel', () => {
  it('only owners and admins approve or ignore', () => {
    expect(canManageQueue('OWNER')).toBe(true);
    expect(canManageQueue('ADMIN')).toBe(true);
    expect(canManageQueue('AP_USER')).toBe(false);
    expect(canManageQueue('DRIVER')).toBe(false);
    expect(canManageQueue(undefined)).toBe(false);
  });

  it('separates emails waiting on their sender from ones to enter by hand', () => {
    const { senders, manual } = splitQueue([
      event({ id: 'a' }),
      event({ id: 'b', reviewReason: 'SPREADSHEET' }),
      event({ id: 'c', reviewReason: 'UNRESOLVED_SENDER', originalFrom: null }),
      event({ id: 'd', reviewReason: 'NO_INVOICE_ATTACHMENT' }),
    ]);
    expect(senders.map((e) => e.id)).toEqual(['a', 'c']);
    expect(manual.map((e) => e.id)).toEqual(['b', 'd']);
    expect(reviewReasonLabel('SPREADSHEET')).toBe('Spreadsheet the app cannot read: enter by hand');
    expect(reviewReasonLabel('CREDIT_MEMO')).toBe('Credit memo: enter by hand');
    expect(reviewReasonLabel('SOMETHING_NEW')).toBe('Needs a look');
  });

  it('an email that failed every try is entered by hand, and says why', () => {
    const failed = event({
      reviewReason: 'READ_FAILED',
      errorMessage: 'Tried 6 times; last try 2026-11-03T15:00:00.000Z: the reader timed out',
    });
    expect(splitQueue([failed]).manual).toEqual([failed]);
    expect(reviewReasonLabel('READ_FAILED')).toBe('Could not be read after several tries: enter by hand');
    expect(failureText(failed)).toBe('the reader timed out');
    expect(failureText(event())).toBeNull();
  });

  it('offers the address always and the domain only when it is not shared mail', () => {
    expect(approveOptions(event())).toEqual({
      address: 'billing@new-supplier.example', domain: 'new-supplier.example', domainAllowed: true,
    });
    expect(approveOptions(event({ originalFrom: 'owner.op@gmail.com' })).domainAllowed).toBe(false);
    expect(approveOptions(event({ reviewReason: 'UNRESOLVED_SENDER', originalFrom: null }))).toBeNull();
    expect(approveOptions(event({ reviewReason: 'SPREADSHEET' }))).toBeNull();
  });

  it('names the real sender, and stops offering actions once approved', () => {
    expect(senderOf(event({ originalFrom: null, fromAddress: 'ap@garden-centre.example' }))).toBe('ap@garden-centre.example');
    expect(isActionable(event())).toBe(true);
    expect(isActionable(event({ requeuedAt: '2026-11-01T12:00:00Z' }))).toBe(false);
    expect(isActionable(event({ status: 'IGNORED' }))).toBe(false);
  });

  it('builds the approve request and refuses an incomplete form', () => {
    const options = approveOptions(event({ originalFrom: 'owner.op@gmail.com' }));
    expect(approveFormError({ supplierId: '' }, options)).toBe('Choose a supplier');
    expect(approveFormError({ supplierId: 'NEW', newName: '  ' }, options)).toBe('Name the new supplier');
    expect(approveFormError({ supplierId: 's1', match: 'domain' }, options)).toMatch(/shared by many senders/);
    expect(approveFormError({ supplierId: 's1', match: 'address' }, options)).toBeNull();

    expect(approvePayload({ supplierId: 's1', match: 'address' })).toEqual({ match: 'address', supplierId: 's1' });
    expect(approvePayload({ supplierId: 'NEW', match: 'domain', newName: ' Example Haulage ', newType: 'TRUCKING_COMPANY' }))
      .toEqual({ match: 'domain', newSupplier: { name: 'Example Haulage', type: 'TRUCKING_COMPANY' } });
  });

  it('lists attachments read first, with size and reason', () => {
    const sorted = sortedAttachments([
      { name: 'image001.png', size: 4200, action: 'skipped', reason: 'inline image (logo or signature)' },
      { name: 'detail.xls', size: 24_576, action: 'review', reason: 'old Excel format (.xls): ask the supplier for PDF or .xlsx' },
      { name: 'invoice.pdf', size: 2_400_000, action: 'read', reason: null },
    ]);
    expect(sorted.map(describeAttachment)).toEqual([
      'invoice.pdf · 2.3 MB · already an invoice in the list',
      'detail.xls · 24 KB · old Excel format (.xls): ask the supplier for PDF or .xlsx',
      'image001.png · 4 KB · inline image (logo or signature)',
    ]);
    expect(sortedAttachments(null)).toEqual([]);
    expect(describeAttachment({ name: '', size: null })).toBe('(no name)');
    expect(describeAttachment({ name: 'held.pdf', action: 'held', reason: 'waiting for the sender to be approved' }))
      .toBe('held.pdf · waiting for the sender to be approved');
  });

  it('says what a read file became: tickets, an invoice and tickets, or a file kept with its invoice', () => {
    expect(describeAttachment({ name: 'scan.pdf', action: 'read', ticketIds: ['t1', 't2'] }))
      .toBe('scan.pdf · filed as 2 tickets');
    expect(describeAttachment({ name: 'inv.pdf', action: 'read', invoiceId: 'i1', ticketIds: ['t1'] }))
      .toBe('inv.pdf · already an invoice in the list, and 1 ticket');
    expect(describeAttachment({ name: 'loads.xlsx', action: 'read', supportingInvoiceId: 'i1' }))
      .toBe('loads.xlsx · kept with its invoice');
    expect(describeAttachment({ name: 'inv.pdf', action: 'read', reason: 'pages 1-2 invoice; page 3 delivery ticket' }))
      .toBe('inv.pdf · pages 1-2 invoice; page 3 delivery ticket');
  });

  it('does not offer the unidentified-supplier placeholder for an approval', () => {
    const choices = approveSupplierChoices([
      { id: 's1', name: 'Example Stone' },
      { id: 's2', name: ' Unidentified Supplier ' },
    ]);
    expect(choices.map((s) => s.id)).toEqual(['s1']);
    expect(approveSupplierChoices(undefined)).toEqual([]);
  });

  it('says what approving did', () => {
    expect(approvedMessage({ added: { value: 'billing@new-supplier.example' }, supplier: { name: 'Example Stone' }, requeued: 2 }))
      .toBe('billing@new-supplier.example added to Example Stone. 2 emails will be read on the next inbox check.');
    expect(approvedMessage({ added: { value: 'x@y.example' }, supplier: { name: 'S' }, requeued: 1 })).toMatch(/1 email will/);
    expect(approvedMessage({ added: { value: 'x@y.example' }, supplier: { name: 'S' }, requeued: 0, beforeCutoff: 2 }))
      .toBe('x@y.example added to S. 0 emails will be read on the next inbox check. 2 older emails were sent before the inbox went live and stay under "Enter by hand".');
    expect(reviewReasonLabel('BEFORE_CUTOFF')).toMatch(/before the inbox went live/);
    expect(splitQueue([event({ reviewReason: 'BEFORE_CUTOFF' })]).manual).toHaveLength(1);
  });
});
