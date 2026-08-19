/**
 * The rules behind the Ticket Review form's save-on-blur behaviour.
 *
 * These live outside the component because the interesting part is a decision,
 * not a rendering concern: given what the field holds and what the server last
 * confirmed, should anything be written at all?
 *
 * The fields used to be uncontrolled (`defaultValue` + `onBlur`), so every blur
 * wrote whether or not anything had changed. Clicking into a field and back out
 * saved the ticket and announced "Ticket updated"; blurring an emptied field
 * persisted `NaN` for quantity and an empty string for the date.
 */

/** The six editable fields, and how a ticket record maps onto them. */
export function reviewValuesFromTicket(ticket) {
  return {
    supplierName: ticket?.supplier?.name || ticket?.supplierName || '',
    ticketDate: ticket?.ticketDate
      ? new Date(ticket.ticketDate).toISOString().split('T')[0]
      : '',
    ticketNumber: ticket?.ticketNumber || '',
    poNumber: ticket?.poNumber || '',
    material: ticket?.material || '',
    quantity: ticket?.quantity ?? '',
  };
}

/**
 * Decides what a blur should do.
 *
 * Returns one of:
 *   { action: 'none' }                     nothing changed — stay silent
 *   { action: 'revert', value }            invalid input — restore the stored value
 *   { action: 'save', value }              a real change — send `value`
 *
 * `revert` carries an optional `message`; a mistyped quantity is worth saying
 * out loud, whereas a cleared date is more likely a slip than an instruction to
 * erase the value.
 */
export function decideReviewCommit(field, nextValue, savedValue) {
  if (String(nextValue ?? '') === String(savedValue ?? '')) {
    return { action: 'none' };
  }

  if (field === 'quantity') {
    const parsed = parseFloat(nextValue);
    if (!Number.isFinite(parsed)) {
      return { action: 'revert', value: savedValue, message: 'Quantity must be a number' };
    }
    return { action: 'save', value: parsed };
  }

  if (field === 'ticketDate' && !nextValue) {
    // Clearing a date is almost always an accident, and an empty string is not
    // a date the server should store.
    return { action: 'revert', value: savedValue };
  }

  return { action: 'save', value: nextValue };
}
