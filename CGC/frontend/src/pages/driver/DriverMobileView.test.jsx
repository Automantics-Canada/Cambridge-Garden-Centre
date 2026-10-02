/**
 * The driver's phone shows a newly assigned stop within about 2 seconds
 * (spec §13), and only while the page is on screen: a phone in a pocket must
 * not keep calling the API every two seconds.
 */
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), post: vi.fn() }));
vi.mock('../../api/axios', () => ({ default: api }));
vi.mock('react-redux', () => ({
  useSelector: (select) => select({ auth: { isAuthenticated: true } }),
  useDispatch: () => vi.fn(),
}));
vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import DriverMobileView from './DriverMobileView';

const PROFILE = { id: 'driver-1', name: 'Dee Driver', stats: { totalToday: 0, completedToday: 0, progress: 0 } };
const NEW_STOP = {
  id: 'delivery-1',
  status: 'PLACED',
  document: {
    documentNumber: '9900-000001',
    customerName: 'Pat Example',
    shippingAddress: '1 Example St, Cambridge',
    phone: '519-555-0100',
    lines: [{ product: 'Clear Stone', quantity: '12', unit: 'MT', lineClass: 'PRODUCT' }],
  },
  order: { id: 'line-1', spruceOrderId: '9900-000001-L1', customerName: 'Pat Example' },
  history: [],
};

/** What the server answers, changed by each test as dispatch would. */
let run;
let failNext;

function setTabHidden(hidden) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
}

const calls = (url) => api.get.mock.calls.filter(([called]) => called === url).length;

/** Lets pending promises settle, then moves the clock on. */
async function advance(ms) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function mountPhone() {
  render(
    <MemoryRouter>
      <DriverMobileView />
    </MemoryRouter>
  );
  await advance(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  setTabHidden(false);
  run = { stops: [], remaining: 0 };
  failNext = null;
  api.get.mockReset();
  api.get.mockImplementation(async (url) => {
    if (failNext) {
      const error = failNext;
      failNext = null;
      throw error;
    }
    if (url === '/api/drivers/me') return { data: PROFILE };
    if (url === '/api/deliveries') {
      return { data: { data: run.stops, pagination: { page: 1, limit: 1, totalCount: run.remaining, totalPages: 1 } } };
    }
    throw new Error(`unexpected ${url}`);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the driver phone', () => {
  it('shows a newly assigned stop within 2 seconds', async () => {
    await mountPhone();
    expect(screen.getByText('All done for now')).toBeTruthy();

    // Dispatch drags an order onto this driver.
    run = { stops: [NEW_STOP], remaining: 1 };
    await advance(2_000);

    expect(screen.getByText('Pat Example')).toBeTruthy();
    expect(screen.queryByText('All done for now')).toBeNull();
  });

  it('checks only the stop every 2 seconds, and the profile when the stop count moves', async () => {
    await mountPhone();
    expect(calls('/api/deliveries')).toBe(1);
    expect(calls('/api/drivers/me')).toBe(1);

    await advance(6_000);
    expect(calls('/api/deliveries')).toBe(4);
    expect(calls('/api/drivers/me')).toBe(1);

    run = { stops: [NEW_STOP], remaining: 1 };
    await advance(2_000);
    expect(calls('/api/deliveries')).toBe(5);
    expect(calls('/api/drivers/me')).toBe(2);
  });

  it('stops checking while the page is hidden, and checks once on return', async () => {
    await mountPhone();
    const before = calls('/api/deliveries');

    setTabHidden(true);
    await advance(20_000);
    expect(calls('/api/deliveries')).toBe(before);

    setTabHidden(false);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await advance(0);
    expect(calls('/api/deliveries')).toBe(before + 1);
  });

  it('keeps the stop on screen through a dropped connection, but not through a refusal', async () => {
    run = { stops: [NEW_STOP], remaining: 1 };
    await mountPhone();
    expect(screen.getByText('Pat Example')).toBeTruthy();

    failNext = Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await advance(2_000);
    expect(screen.getByText('Pat Example')).toBeTruthy();
    expect(screen.queryByText('Access denied')).toBeNull();

    failNext = Object.assign(new Error('Unauthorized'), { response: { status: 401 } });
    await advance(2_000);
    expect(screen.getByText('Access denied')).toBeTruthy();
  });
});
