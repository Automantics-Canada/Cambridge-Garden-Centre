import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');

describe('legacy order nullability', () => {
  it('models the production-nullable buyer type, quantity and unit columns accurately', () => {
    const orderModel = schema.match(/model Order \{([\s\S]*?)\n\}/)?.[1] || '';
    assert.match(orderModel, /buyerType\s+BuyerType\?/);
    assert.match(orderModel, /quantity\s+Decimal\?/);
    assert.match(orderModel, /unit\s+String\?/);
  });
});
