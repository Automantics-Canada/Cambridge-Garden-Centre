const KEY = 'cgc-theme';

/** Reads the saved choice; `null` means "follow the operating system". */
export function getStoredTheme() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

/** Remembers the choice. `null` clears it, going back to the OS setting. */
export function storeTheme(theme) {
  try {
    if (theme) localStorage.setItem(KEY, theme);
    else localStorage.removeItem(KEY);
  } catch {
    /* private browsing — the toggle still works for this session */
  }
}

/** Applies a theme by stamping the root element, which the tokens react to. */
export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') {
    root.setAttribute('data-theme', theme);
  } else {
    root.removeAttribute('data-theme');
  }
}

/** True when the OS is currently asking for dark. */
export function prefersDark() {
  return (
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(prefers-color-scheme: dark)').matches
  );
}
