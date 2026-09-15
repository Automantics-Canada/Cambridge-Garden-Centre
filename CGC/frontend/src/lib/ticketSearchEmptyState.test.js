import { describe, expect, it } from 'vitest';
import { narrowingTicketFilters, ticketsEmptyState } from './ticketSearchEmptyState';

describe('narrowingTicketFilters', () => {
  it('is empty on the default view', () => {
    expect(narrowingTicketFilters({ activeTab: 'ALL', supplierId: '', source: '' })).toEqual([]);
    expect(narrowingTicketFilters()).toEqual([]);
  });

  it('names every filter that limits the list', () => {
    expect(
      narrowingTicketFilters({
        activeTab: 'LINKED',
        supplierId: 'sup-1',
        supplierName: 'Millbrook Aggregates',
        source: 'WHATSAPP',
        startDate: '2026-09-01',
      })
    ).toEqual([
      'the Linked tab',
      'supplier Millbrook Aggregates',
      'source WhatsApp',
      'a date range',
    ]);
  });

  it('still names a supplier filter before the supplier list has loaded', () => {
    expect(narrowingTicketFilters({ supplierId: 'sup-1' })).toEqual(['a supplier']);
  });

  it('counts a range with only an end date', () => {
    expect(narrowingTicketFilters({ endDate: '2026-09-15' })).toEqual(['a date range']);
  });
});

describe('ticketsEmptyState', () => {
  it('blames the filters, and offers to drop them, when they hid the search', () => {
    // A ticket number that exists, searched with Source still on WhatsApp.
    const state = ticketsEmptyState({ search: ' T-88213 ', filters: ['source WhatsApp'] });
    expect(state.title).toBe('No tickets match "T-88213" with these filters');
    expect(state.message).toBe('Still filtering by source WhatsApp.');
    expect(state.offerSearchAll).toBe(true);
  });

  it('says what search covers when nothing else is limiting it', () => {
    const state = ticketsEmptyState({ search: 'zzz', filters: [] });
    expect(state.title).toBe('No tickets match "zzz"');
    expect(state.offerSearchAll).toBe(false);
  });

  it('keeps the general message when there is no search', () => {
    const state = ticketsEmptyState({ search: '   ', filters: ['the Linked tab'] });
    expect(state.title).toBe('No tickets match');
    expect(state.offerSearchAll).toBe(false);
  });
});
