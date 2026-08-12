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
    const id = setInterval(() => {
      callbackRef.current();
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
}
