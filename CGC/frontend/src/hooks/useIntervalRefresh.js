import { useEffect, useRef } from 'react';

/**
 * Call `callback` on a fixed interval while `enabled` is true.
 *
 * The latest callback is always used; changing the function identity does not
 * reset the timer. Used to replace postgres_changes subscriptions that will
 * stop receiving rows after the public-schema lockdown.
 */
export function useIntervalRefresh(callback, intervalMs, { enabled = true } = {}) {
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled) return undefined;

    // Background tabs must not keep hitting the API. Several of these screens
    // poll endpoints that are expensive server-side, and a dashboard left open
    // on a spare monitor would otherwise generate load indefinitely.
    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      callbackRef.current();
    };

    const id = setInterval(tick, intervalMs);

    // Refresh once on return so a hidden tab is not left showing stale data.
    const onVisible = () => {
      if (!document.hidden) callbackRef.current();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs, enabled]);
}
