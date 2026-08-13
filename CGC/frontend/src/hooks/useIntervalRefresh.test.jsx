/**
 * useIntervalRefresh is shared by Tickets, Invoices, Dispatch Board and Driver
 * Mobile. The hidden-tab suppression added here is global to all four, so the
 * behaviour is pinned rather than left implicit.
 *
 * The polling itself exists because the public-schema lockdown stops the
 * postgres_changes subscriptions these pages used to rely on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIntervalRefresh } from './useIntervalRefresh';

/** jsdom reports document.hidden as false and has no way to set it directly. */
function setTabHidden(hidden) {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  });
}

function fireVisibilityChange() {
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  setTabHidden(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useIntervalRefresh', () => {
  it('invokes the callback once per interval while the tab is visible', () => {
    const callback = vi.fn();
    renderHook(() => useIntervalRefresh(callback, 1000));

    expect(callback).not.toHaveBeenCalled(); // no immediate call on mount

    act(() => vi.advanceTimersByTime(3000));
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it('suppresses ticks while the tab is hidden', () => {
    const callback = vi.fn();
    renderHook(() => useIntervalRefresh(callback, 1000));

    setTabHidden(true);
    act(() => vi.advanceTimersByTime(5000));
    expect(callback).not.toHaveBeenCalled();
  });

  it('resumes ticking after the tab becomes visible again', () => {
    const callback = vi.fn();
    renderHook(() => useIntervalRefresh(callback, 1000));

    setTabHidden(true);
    act(() => vi.advanceTimersByTime(3000));
    expect(callback).not.toHaveBeenCalled();

    setTabHidden(false);
    act(() => vi.advanceTimersByTime(2000));
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('refreshes exactly once when the tab regains visibility', () => {
    const callback = vi.fn();
    renderHook(() => useIntervalRefresh(callback, 60_000));

    setTabHidden(true);
    act(() => fireVisibilityChange());
    expect(callback).not.toHaveBeenCalled(); // going hidden must not refresh

    setTabHidden(false);
    act(() => fireVisibilityChange());
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('clears the timer and the listener on unmount', () => {
    const callback = vi.fn();
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { unmount } = renderHook(() => useIntervalRefresh(callback, 1000));

    unmount();

    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));

    act(() => vi.advanceTimersByTime(5000));
    expect(callback).not.toHaveBeenCalled();

    act(() => fireVisibilityChange());
    expect(callback).not.toHaveBeenCalled();
  });

  it('does not double-subscribe when the callback identity changes', () => {
    // Pages pass inline arrow functions, so the identity changes on every
    // render. If that resubscribed, a re-rendering page would accumulate
    // timers and multiply its own request rate.
    const first = vi.fn();
    const { rerender } = renderHook(({ cb }) => useIntervalRefresh(cb, 1000), {
      initialProps: { cb: first },
    });

    const second = vi.fn();
    rerender({ cb: second });
    const third = vi.fn();
    rerender({ cb: third });

    act(() => vi.advanceTimersByTime(1000));

    // Exactly one tick total, routed to the newest callback.
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(third).toHaveBeenCalledTimes(1);
  });

  it('does not restart the interval when the callback changes', () => {
    // A resubscribe would reset the countdown, so a page re-rendering faster
    // than the interval would never actually poll.
    const callback = vi.fn();
    const { rerender } = renderHook(({ cb }) => useIntervalRefresh(cb, 1000), {
      initialProps: { cb: callback },
    });

    act(() => vi.advanceTimersByTime(900));
    rerender({ cb: vi.fn(callback) });
    act(() => vi.advanceTimersByTime(100));

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('does not schedule anything while disabled', () => {
    const callback = vi.fn();
    renderHook(() => useIntervalRefresh(callback, 1000, { enabled: false }));

    act(() => vi.advanceTimersByTime(5000));
    act(() => fireVisibilityChange());
    expect(callback).not.toHaveBeenCalled();
  });

  it('starts polling when it becomes enabled', () => {
    // Driver Mobile disables polling during an upload and re-enables afterwards.
    const callback = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }) => useIntervalRefresh(callback, 1000, { enabled }),
      { initialProps: { enabled: false } }
    );

    act(() => vi.advanceTimersByTime(3000));
    expect(callback).not.toHaveBeenCalled();

    rerender({ enabled: true });
    act(() => vi.advanceTimersByTime(2000));
    expect(callback).toHaveBeenCalledTimes(2);
  });
});
