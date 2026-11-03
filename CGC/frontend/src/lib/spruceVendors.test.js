import { describe, expect, it } from 'vitest';
import { describeUnmapped, mappedMessage, normaliseVendorCode, sortVendorCodes } from './spruceVendors';

describe('Spruce vendor codes', () => {
  it('reads codes the way Spruce prints them', () => {
    expect(normaliseVendorCode(' examplev01 ')).toBe('EXAMPLEV01');
    expect(normaliseVendorCode('has space')).toBeNull();
    expect(normaliseVendorCode('')).toBeNull();
  });

  it('lists active codes before retired ones', () => {
    const sorted = sortVendorCodes([
      { code: 'ZETA01', active: true },
      { code: 'ALPHA01', active: false },
      { code: 'BETA01', active: true },
    ]);
    expect(sorted.map((c) => c.code)).toEqual(['BETA01', 'ZETA01', 'ALPHA01']);
  });

  it('describes unmapped codes and the result of mapping one', () => {
    expect(describeUnmapped({ code: 'EXAMPLEV01', lineCount: 1, location: 'Example Yard' })).toBe('EXAMPLEV01 · 1 line · Example Yard');
    expect(mappedMessage({ code: 'EXAMPLEV01', changed: true, linkedLines: 2 })).toBe(
      'EXAMPLEV01 mapped. 2 imported lines now name this supplier.'
    );
    expect(mappedMessage({ code: 'EXAMPLEV01', changed: false, linkedLines: 0 })).toBe('EXAMPLEV01 is already mapped here.');
  });
});
