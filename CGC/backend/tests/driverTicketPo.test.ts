// config/env.ts validates the environment at import time, so the placeholder
// config has to be loaded before anything under src/ is pulled in.
import './setupEnv.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { supplierPoForTicket } from '../src/modules/deliveries/deliveries.service.js';

const lines = (...pos: Array<string | null>) => pos.map(poNumber => ({ poNumber }));

describe("a driver's ticket takes the order's supplier PO", () => {
  it('when the order is on exactly one PO, however often its lines repeat it', () => {
    assert.equal(supplierPoForTicket(lines(null, '2608-355356', null, '2608-355356')), '2608-355356');
    // The same PO spelled the ways Spruce and the yards write it.
    assert.equal(supplierPoForTicket(lines('2608-355356', ' 2608 355356 ')), '2608-355356');
  });

  it('not when the order is on no PO: stock from the yard', () => {
    assert.equal(supplierPoForTicket(lines(null, '  ')), null);
    assert.equal(supplierPoForTicket([]), null);
  });

  it('not when the order is on several POs, since the ticket could be for any', () => {
    assert.equal(supplierPoForTicket(lines('2608-355355', '2608-355356')), null);
  });
});
