import { describe, expect, it } from 'vitest';
import { haulLoadRows, isHaulLine, missingRateText } from './invoiceHaul';

// Invented names and numbers.
const load = (overrides = {}) => ({
  id: 'load-1',
  documentNumber: '990101',
  sequence: 2,
  carrierName: 'Example Haulage Ltd.',
  rate: 185,
  rateUnit: 'LOAD',
  quantity: null,
  tripRef: null,
  ticketNumber: 'TK-7001',
  ...overrides,
});

describe('isHaulLine', () => {
  it('is a haul line only when it carries the loads it bills', () => {
    expect(isHaulLine({ haulLoads: [load()] })).toBe(true);
    expect(isHaulLine({ haulLoads: [] })).toBe(false);
    expect(isHaulLine({})).toBe(false);
    expect(isHaulLine(null)).toBe(false);
  });
});

describe('haulLoadRows', () => {
  it('shows the order, load, carrier and the rate dispatch set', () => {
    expect(haulLoadRows({ haulLoads: [load()] })).toEqual([
      {
        id: 'load-1',
        order: 'Order 990101',
        load: 'Load 2',
        carrier: 'Example Haulage Ltd.',
        rate: '$185.00 / load',
        trip: '',
        ticket: 'Ticket TK-7001',
      },
    ]);
  });

  it('names the trip and the unit of a per-hour or per-tonne rate', () => {
    const [row] = haulLoadRows({ haulLoads: [load({ tripRef: 'T-12', rate: 9.5, rateUnit: 'TONNE', ticketNumber: null })] });
    expect(row.trip).toBe('Trip T-12');
    expect(row.rate).toBe('$9.50 / t');
    expect(row.ticket).toBe('');
  });

  it('says when dispatch left the rate blank rather than showing nothing', () => {
    const [row] = haulLoadRows({ haulLoads: [load({ rate: null, rateUnit: null, carrierName: null })] });
    expect(row.rate).toBe('No rate set');
    expect(row.carrier).toBe('Carrier not recorded');
  });

  it('has no rows for a material line', () => {
    expect(haulLoadRows({})).toEqual([]);
  });
});

describe('missingRateText', () => {
  it('sends a haul line to dispatch and a material line to the rate list', () => {
    expect(missingRateText({ haulLoads: [load()] })).toMatch(/dispatch/);
    expect(missingRateText({ haulLoads: [] })).toBe('No agreed rate on file for this product.');
  });

  it('does not send a trucking line with no load found to the product rate list', () => {
    const item = {
      haulLoads: [],
      matchResult: { evidence: [{ name: 'haulLoad', passed: false, code: 'NO_LOAD_FOUND', detail: 'x' }] },
    };
    expect(missingRateText(item)).toMatch(/No dispatched load found/);
    expect(missingRateText(item)).not.toMatch(/product/);
  });
});
