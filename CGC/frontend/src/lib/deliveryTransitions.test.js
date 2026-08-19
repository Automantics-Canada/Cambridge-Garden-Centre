import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DELIVERY_TRANSITIONS,
  DRIVER_ALLOWED_TARGETS,
  TERMINAL_STATUSES,
  statusOptionsFor,
} from './deliveryTransitions';

/**
 * The frontend keeps its own copy of the state machine so the dropdown can stop
 * offering moves the server will refuse. A copy is only safe while it matches,
 * so this parses the backend module and compares the two directly. If someone
 * edits one table and not the other, this fails rather than the operator
 * finding out through a 409.
 */
const backendSource = readFileSync(
  resolve('../backend/src/modules/deliveries/deliveryTransitions.ts'),
  'utf8',
);

function parseBackendTable(source, constName) {
  const start = source.indexOf(`export const ${constName}`);
  expect(start, `${constName} not found in the backend module`).toBeGreaterThan(-1);
  const open = source.indexOf('{', start);
  const close = source.indexOf('} as const', open);
  const body = source.slice(open + 1, close);

  const table = {};
  const entry = /(\w+):\s*\[([^\]]*)\]/g;
  let match;
  while ((match = entry.exec(body)) !== null) {
    table[match[1]] = match[2]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  return table;
}

function parseBackendList(source, constName) {
  const start = source.indexOf(`export const ${constName}`);
  expect(start, `${constName} not found in the backend module`).toBeGreaterThan(-1);
  // Skip past the type annotation — `: readonly DeliveryStatus[] =` contains a
  // pair of brackets that is not the value.
  const assign = source.indexOf('=', start);
  const open = source.indexOf('[', assign);
  const close = source.indexOf(']', open);
  return source
    .slice(open + 1, close)
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

describe('delivery transitions mirror the server', () => {
  it('has the same states and the same legal successors', () => {
    const backend = parseBackendTable(backendSource, 'DELIVERY_TRANSITIONS');
    // Guard against the parser silently matching nothing.
    expect(Object.keys(backend).length).toBeGreaterThan(4);
    expect(DELIVERY_TRANSITIONS).toEqual(backend);
  });

  it('agrees on which states are terminal', () => {
    expect(TERMINAL_STATUSES).toEqual(parseBackendList(backendSource, 'TERMINAL_STATUSES'));
  });

  it('agrees on what a driver may set', () => {
    expect(DRIVER_ALLOWED_TARGETS).toEqual(
      parseBackendList(backendSource, 'DRIVER_ALLOWED_TARGETS'),
    );
  });
});

describe('statusOptionsFor', () => {
  it('always shows the delivery current state first', () => {
    const options = statusOptionsFor({ status: 'UNASSIGNED' });
    expect(options[0]).toMatchObject({ value: 'UNASSIGNED', current: true });
  });

  it('does not offer a move the server would refuse', () => {
    // The reported bug: the dropdown offered In Transit on an UNASSIGNED stop.
    const values = statusOptionsFor({ status: 'UNASSIGNED' }).map((o) => o.value);
    expect(values).not.toContain('IN_TRANSIT');
    expect(values).toEqual(['UNASSIGNED', 'PLACED', 'CANCELLED']);
  });

  it('offers nothing beyond the current state once terminal', () => {
    expect(statusOptionsFor({ status: 'DELIVERED' })).toHaveLength(1);
    expect(statusOptionsFor({ status: 'CANCELLED' })).toHaveLength(1);
  });

  it('disables Delivered until a delivery photo exists, and says why', () => {
    const withoutPhoto = statusOptionsFor({ status: 'IN_TRANSIT', deliveryPhotoUrl: null });
    const delivered = withoutPhoto.find((o) => o.value === 'DELIVERED');
    expect(delivered.disabled).toBe(true);
    expect(delivered.reason).toMatch(/photo/i);

    const withPhoto = statusOptionsFor({
      status: 'IN_TRANSIT',
      deliveryPhotoUrl: 'https://example.test/p.jpg',
    });
    expect(withPhoto.find((o) => o.value === 'DELIVERED').disabled).toBe(false);
  });

  it('hides dispatch-only moves from a driver', () => {
    const values = statusOptionsFor({ status: 'PLACED' }, { role: 'DRIVER' }).map((o) => o.value);
    expect(values).not.toContain('CANCELLED');
    expect(values).not.toContain('UNASSIGNED');
    expect(values).toContain('IN_TRANSIT');
  });
});
