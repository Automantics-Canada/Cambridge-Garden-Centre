/**
 * The plain label a ticket gets when the app holds two copies of it.
 *
 * Client, Oct 2026, Q15: some suppliers attach their tickets to the invoice
 * email, though most tickets come from the drivers. The supplier's emailed
 * copy is stored as a second copy of the driver's photo of the same ticket,
 * and the load is counted once. Listed side by side with nothing said, the
 * two rows read as two loads, so each says what it is.
 *
 * Reads only what the tickets API returns: `duplicateOfTicketId`,
 * `duplicateOf` and `copies`. Returns null when the ticket has no other copy.
 */
export function ticketCopyLabel(ticket) {
  if (!ticket) return null;

  if (ticket.duplicateOfTicketId) {
    const whose = ticket.source === 'EMAIL' ? "Supplier's copy" : 'Second copy';
    const original = ticket.duplicateOf?.ticketNumber;
    return original ? `${whose} of ${original}` : `${whose} of another ticket`;
  }

  const copies = Array.isArray(ticket.copies) ? ticket.copies : [];
  if (copies.length === 0) return null;
  return copies.some(copy => copy.source === 'EMAIL') ? 'Supplier also sent a copy' : 'Another copy was received';
}

/** The hover text under the label: what the copy means for the money. */
export const TICKET_COPY_HINT = 'Two copies of one ticket. The load is counted once.';
