import { useEffect, useState } from 'react';

/**
 * Trailing-edge debounce for a value.
 *
 * Search boxes drive server-side queries now, so every keystroke would
 * otherwise be its own request. The debounced copy is what the query key is
 * built from, which also keeps the request cache from filling with an entry
 * per prefix.
 */
export function useDebouncedValue(value, delayMs = 300) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    if (value === debounced) return undefined;
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs, debounced]);

  return debounced;
}

export default useDebouncedValue;
