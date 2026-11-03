/**
 * A ticket or PO number reduced to lower-case letters and digits.
 *
 * People type a number the way the paper prints it and the extraction stores it
 * the way it read it, so "T88213", "#t 88213" and "T-88213" must all find the
 * same ticket. Mirrors the trigger that fills `Ticket.numberSearchKey` in
 * migration 20260915120000_ticket_number_search_key; change both or neither.
 *
 * Kept here, apart from the ticket service, so the extraction and the trucking
 * invoice matcher compare numbers exactly the way ticket search does without
 * pulling in the database.
 */
export function numberSearchKey(term: string): string {
  return term.replace(/[^A-Za-z0-9]+/g, '').toLowerCase();
}
