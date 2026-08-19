import { describe, expect, it } from 'vitest';
import { formatQuantity } from './quantity';

describe('formatQuantity', () => {
  it('does not misreport a missing quantity as zero', () => {
    expect(formatQuantity(null, 'ton')).toBe('Not recorded');
    expect(formatQuantity(undefined, 'ton')).toBe('Not recorded');
  });

  it('keeps a real zero', () => {
    expect(formatQuantity(0, 'ton')).toBe('0 ton');
  });

  it('renders numeric database strings with their unit', () => {
    expect(formatQuantity('12.50', 'tonne')).toBe('12.5 tonne');
  });
});
