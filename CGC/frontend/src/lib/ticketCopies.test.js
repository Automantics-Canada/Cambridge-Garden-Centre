import { describe, expect, it } from 'vitest';
import { ticketCopyLabel } from './ticketCopies';

describe('ticketCopyLabel', () => {
  it("names the driver's ticket on the supplier's emailed copy", () => {
    expect(
      ticketCopyLabel({
        source: 'EMAIL',
        duplicateOfTicketId: 'driver-ticket',
        duplicateOf: { id: 'driver-ticket', ticketNumber: 'EX-70001', source: 'MANUAL' },
        copies: [],
      })
    ).toBe("Supplier's copy of EX-70001");
  });

  it('says the supplier also sent a copy on the driver\'s ticket', () => {
    expect(
      ticketCopyLabel({ source: 'MANUAL', duplicateOfTicketId: null, copies: [{ id: 'c', ticketNumber: 'EX 70001', source: 'EMAIL' }] })
    ).toBe('Supplier also sent a copy');
  });

  it('still labels a copy when the original has no number, or the copy is not emailed', () => {
    expect(ticketCopyLabel({ source: 'EMAIL', duplicateOfTicketId: 'x', duplicateOf: { ticketNumber: null } })).toBe(
      "Supplier's copy of another ticket"
    );
    expect(ticketCopyLabel({ source: 'WHATSAPP', duplicateOfTicketId: 'x', duplicateOf: { ticketNumber: 'EX-1' } })).toBe(
      'Second copy of EX-1'
    );
    expect(ticketCopyLabel({ source: 'MANUAL', copies: [{ source: 'WHATSAPP' }] })).toBe('Another copy was received');
  });

  it('says nothing for a ticket with no other copy, or a list from before the API sent copies', () => {
    expect(ticketCopyLabel({ source: 'MANUAL', duplicateOfTicketId: null, copies: [] })).toBeNull();
    expect(ticketCopyLabel({ source: 'EMAIL' })).toBeNull();
    expect(ticketCopyLabel(null)).toBeNull();
  });
});
