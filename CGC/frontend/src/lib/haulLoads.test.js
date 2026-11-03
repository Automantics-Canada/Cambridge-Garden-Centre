import { describe, expect, it } from 'vitest';
import {
  CGC_FLEET,
  carrierLabel,
  expectedText,
  changedLoadFields,
  formatHaulRate,
  loadForm,
  loadSummary,
  loadedAtSuppliers,
  needsHaulRate,
  newLoadForm,
  suggestedCarrier,
  tripText,
  validateLoadForm,
} from './haulLoads';

// Every name and number here is invented.
const order = (haulLoads = []) => ({ id: 'o1', wholeOrder: true, haulLoads });
const fleetDriver = { id: 'd1', type: 'CGC_FLEET', name: 'Example Driver' };
const broker = { id: 'd2', type: 'INDEPENDENT', name: 'Example Broker', companyName: 'Example Haulage', ratePerTrip: '180' };
const carriers = [{ id: 'c1', name: 'Example Haulage' }, { id: 'c2', name: 'Other Haulage' }];

describe('formatHaulRate', () => {
  it('says the rate and what it is per', () => {
    expect(formatHaulRate(95, 'LOAD')).toBe('$95.00 / load');
    expect(formatHaulRate('42.5', 'HOUR')).toBe('$42.50 / hr');
    expect(formatHaulRate(6.25, 'TONNE')).toBe('$6.25 / t');
    expect(formatHaulRate(0, 'LOAD')).toBe('$0.00 / load');
  });

  it('is empty without a rate', () => {
    expect(formatHaulRate(null, 'LOAD')).toBe('');
    expect(formatHaulRate('', 'LOAD')).toBe('');
  });
});

describe('needsHaulRate (the "No haul rate" badge)', () => {
  it('flags a stop on a brokered driver with no rated load', () => {
    expect(needsHaulRate(order([]), broker)).toBe(true);
    expect(needsHaulRate(order([{ carrierSupplierId: null, rate: null }]), broker)).toBe(true);
    expect(needsHaulRate(order([{ carrierSupplierId: 'c1', rate: 180, rateUnit: 'LOAD' }]), broker)).toBe(false);
  });

  it('flags a load with a carrier or a brokered driver but no rate, wherever the order is', () => {
    expect(needsHaulRate(order([{ carrierSupplierId: 'c1', rate: null }]))).toBe(true);
    expect(needsHaulRate(order([{ carrierSupplierId: null, driverType: 'INDEPENDENT', rate: null }]))).toBe(true);
    expect(needsHaulRate(order([{ carrierSupplierId: 'c1', rate: 95 }, { carrierSupplierId: 'c1', rate: null }]), fleetDriver)).toBe(true);
  });

  it('leaves CGC\'s own trucks alone, and orders with nothing to rate', () => {
    expect(needsHaulRate(order([]), fleetDriver)).toBe(false);
    expect(needsHaulRate(order([{ carrierSupplierId: null, rate: null }]), fleetDriver)).toBe(false);
    expect(needsHaulRate(order([]))).toBe(false);
    expect(needsHaulRate({ wholeOrder: false }, broker)).toBe(false);
    expect(needsHaulRate({ id: 'o', wholeOrder: true }, fleetDriver)).toBe(false);
  });
});

describe('loadSummary and carrierLabel', () => {
  it('counts the loads and names the rate once', () => {
    expect(loadSummary(order([]))).toBe('');
    expect(loadSummary(order([{ rate: null }]))).toBe('1 load');
    expect(loadSummary(order([{ rate: 95, rateUnit: 'LOAD' }, { rate: 95, rateUnit: 'LOAD' }]))).toBe('2 loads · $95.00 / load');
    expect(loadSummary(order([{ rate: 95, rateUnit: 'LOAD' }, { rate: 40, rateUnit: 'HOUR' }]))).toBe('2 loads · mixed rates');
  });

  it('names the carrier, a brokered driver, or CGC fleet', () => {
    expect(carrierLabel({ carrierName: 'Example Haulage' })).toBe('Example Haulage');
    expect(carrierLabel({ driverType: 'INDEPENDENT', driverName: 'Example Broker (Example Haulage)' })).toBe('Example Broker (Example Haulage)');
    expect(carrierLabel({})).toBe('CGC fleet');
  });
});

describe('the new-load form', () => {
  it('offers the brokered driver\'s company and per-trip rate, only on an exact name match', () => {
    expect(suggestedCarrier(broker, carriers)).toEqual(carriers[0]);
    expect(suggestedCarrier({ ...broker, companyName: ' example  haulage ' }, carriers)).toEqual(carriers[0]);
    expect(suggestedCarrier({ ...broker, companyName: 'Example' }, carriers)).toBe(null);
    expect(suggestedCarrier(broker, [...carriers, { id: 'c3', name: 'EXAMPLE HAULAGE' }])).toBe(null);
    expect(suggestedCarrier(fleetDriver, carriers)).toBe(null);

    expect(newLoadForm(broker, carriers)).toMatchObject({ carrierSupplierId: 'c1', rate: '180', rateUnit: 'LOAD' });
    expect(newLoadForm(fleetDriver, carriers)).toMatchObject({ carrierSupplierId: CGC_FLEET, rate: '' });
    expect(newLoadForm(null, carriers)).toMatchObject({ carrierSupplierId: CGC_FLEET, rate: '' });
  });
});

describe('validateLoadForm', () => {
  const base = newLoadForm();

  it('sends a rate with its unit, and no unit without a rate', () => {
    expect(validateLoadForm({ ...base, carrierSupplierId: 'c1', rate: '$1,200.50', rateUnit: 'HOUR', quantity: '3' }).body)
      .toEqual({
        carrierSupplierId: 'c1', rate: '1200.50', rateUnit: 'HOUR', quantity: '3',
        sourceSupplierId: null, tripRef: null, ticketNumber: null, notes: null,
      });
    expect(validateLoadForm(base).body).toMatchObject({ carrierSupplierId: null, rate: null, rateUnit: null });
  });

  it('refuses a negative or wordy rate, a zero quantity and a missing unit', () => {
    expect(validateLoadForm({ ...base, rate: '-5' }).errors.rate).toBeTruthy();
    expect(validateLoadForm({ ...base, rate: 'ninety' }).errors.rate).toBeTruthy();
    expect(validateLoadForm({ ...base, rate: '1.23456' }).errors.rate).toBeTruthy();
    expect(validateLoadForm({ ...base, rate: '95', rateUnit: '' }).errors.rateUnit).toBeTruthy();
    expect(validateLoadForm({ ...base, quantity: '0' }).errors.quantity).toBeTruthy();
    expect(validateLoadForm({ ...base, tripRef: 'x'.repeat(41) }).errors.tripRef).toBeTruthy();
    expect(validateLoadForm({ ...base, rate: '-5' }).body).toBe(null);
    expect(validateLoadForm({ ...base, rate: '0' }).errors).toEqual({});
  });
});

describe('changedLoadFields', () => {
  const load = {
    carrierSupplierId: 'c1', rate: 95, rateUnit: 'LOAD', quantity: null, sourceSupplierId: null,
    tripRef: 'T-21', ticketNumber: null, notes: null,
  };

  it('sends only what changed, so a paid load\'s note can be saved alone', () => {
    const { body } = validateLoadForm({ ...loadForm(load), rate: '95.00', tripRef: 't-21', notes: 'Paid' });
    expect(changedLoadFields(load, body)).toEqual({ notes: 'Paid' });
    const repriced = validateLoadForm({ ...loadForm(load), rate: '90' }).body;
    expect(changedLoadFields(load, repriced)).toEqual({ rate: '90' });
  });
});

describe('expectedText', () => {
  it('says the expected quantity in the rate\'s unit', () => {
    expect(expectedText({ quantity: 3, rateUnit: 'HOUR' })).toBe('Expected 3 hours');
    expect(expectedText({ quantity: 22.5, rateUnit: 'TONNE' })).toBe('Expected 22.5 tonnes');
    expect(expectedText({ quantity: 2, rateUnit: null })).toBe('Expected 2');
    expect(expectedText({ quantity: null, rateUnit: 'LOAD' })).toBe('');
  });
});

describe('tripText', () => {
  it('names the trip, its loads and its orders', () => {
    expect(tripText({ tripRef: null })).toBe('');
    expect(tripText({ tripRef: 'T-21' })).toBe('Trip T-21');
    expect(tripText({ tripRef: 'T-21', trip: { loads: 2, orders: ['9900-1', '9900-2'], sameRate: true } }))
      .toBe('Trip T-21: 2 loads, 9900-1, 9900-2');
  });
});

describe('loadedAtSuppliers', () => {
  it('never offers a trucking company as where a load was loaded', () => {
    const suppliers = [
      { id: 's1', name: 'Example Pit', type: 'SUPPLIER' },
      { id: 't1', name: 'Example Haulage', type: 'TRUCKING_COMPANY' },
      { id: 's2', name: 'Untyped Yard' },
    ];
    expect(loadedAtSuppliers(suppliers).map((supplier) => supplier.id)).toEqual(['s1', 's2']);
    expect(loadedAtSuppliers(undefined)).toEqual([]);
  });
});
