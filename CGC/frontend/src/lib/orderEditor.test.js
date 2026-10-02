import { describe, expect, it } from 'vitest';

import { editRequest, formFromOrder, lineUpdateFor, overrideFor, spruceText, updateFor, updateNote } from './orderEditor';

const order = {
  id: 'doc-1',
  customerName: 'Pat Example',
  phone: '519-555-0100',
  shippingAddress: null,
  deliveryInstructions: null,
  deliveryDate: '2026-08-14T00:00:00.000Z',
  deliveryType: 'SLINGER',
  deliveryTruck: null,
  dispatcherNotes: null,
  lines: [{ id: 'line-1', product: 'Clear Stone', quantity: '12.0000', unit: 'MT' }],
  overrides: [{ field: 'phone', lineId: null, value: '519-555-0100', spruceValue: null, spruceChanged: false }],
};

describe('the edit form', () => {
  it('starts from the order as it stands', () => {
    const form = formFromOrder(order);
    expect(form.fields.deliveryDate).toBe('2026-08-14');
    expect(form.fields.shippingAddress).toBe('');
    expect(form.lines['line-1']).toEqual({ product: 'Clear Stone', quantity: '12' });
  });

  it('sends nothing when nothing changed, so opening and saving creates no corrections', () => {
    expect(editRequest(order, formFromOrder(order))).toBeNull();
  });

  it('sends only what changed', () => {
    const form = formFromOrder(order);
    form.fields.shippingAddress = '64 Example St, Kitchener';
    form.lines['line-1'].quantity = '11';
    form.dispatcherNotes = 'Gate code 4411';

    expect(editRequest(order, form)).toEqual({
      fields: { shippingAddress: '64 Example St, Kitchener' },
      lines: [{ id: 'line-1', quantity: '11' }],
      dispatcherNotes: 'Gate code 4411',
    });
  });

  it('ignores spaces typed around an unchanged value', () => {
    const form = formFromOrder(order);
    form.fields.customerName = '  Pat Example ';
    expect(editRequest(order, form)).toBeNull();
  });
});

describe('corrections beside Spruce', () => {
  it('finds a field\'s correction and says what Spruce has', () => {
    const override = overrideFor(order, 'phone');
    expect(override?.value).toBe('519-555-0100');
    expect(spruceText(override, 'phone')).toBe('nothing');
    expect(overrideFor(order, 'phone', 'line-1')).toBeNull();
    expect(spruceText({ spruceValue: 'DUMP' }, 'deliveryType')).toBe('Dump');
  });
});

describe("what today's upload changed", () => {
  const updated = {
    ...order,
    updates: [
      { field: 'shippingAddress', lineId: null, oldValue: '64 Example St, Kitchener', newValue: '70 Example St, Kitchener' },
      { field: 'deliveryType', lineId: null, oldValue: 'DUMP', newValue: 'SLINGER' },
      { field: 'deliveryTruck', lineId: null, oldValue: null, newValue: 'Small truck' },
      { field: 'quantity', lineId: 'line-1', oldValue: '10', newValue: '12' },
      { field: 'lineAdded', lineId: 'line-2', oldValue: null, newValue: '2 BAG Polymeric Sand' },
      { field: 'lineRemoved', lineId: 'line-3', oldValue: '1 EA Delivery', newValue: null },
    ],
  };

  it('says what each updated field was', () => {
    expect(updateNote(updateFor(updated, 'shippingAddress'), 'shippingAddress'))
      .toBe("Updated by today's upload (was 64 Example St, Kitchener).");
    expect(updateNote(updateFor(updated, 'deliveryType'), 'deliveryType')).toBe("Updated by today's upload (was Dump).");
    expect(updateNote(updateFor(updated, 'deliveryTruck'), 'deliveryTruck')).toBe("Updated by today's upload (was nothing).");
    expect(updateNote(updateFor(updated, 'quantity', 'line-1'), 'quantity')).toBe("Updated by today's upload (was 10).");
  });

  it('marks a line added or taken off, and nothing that did not change', () => {
    expect(updateNote(lineUpdateFor(updated, 'line-2'))).toBe("Added by today's upload.");
    expect(updateNote(lineUpdateFor(updated, 'line-3'))).toMatch(/^Not in today's upload/);
    expect(updateFor(updated, 'phone')).toBeNull();
    expect(updateFor(updated, 'quantity')).toBeNull();
    expect(updateNote(null, 'phone')).toBeNull();
    expect(updateFor(order, 'shippingAddress')).toBeNull();
  });
});
