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

/**
 * Applies a theme by stamping the root element, which the tokens react to.
 *
 * `colorScheme` has to move with it. It governs everything the browser paints
 * itself — input and select fills, dropdown popups, the native date picker,
 * scrollbars — and none of that reads our CSS tokens. It used to be hard-coded
 * to `light dark` in index.css, so a machine set to dark at the OS level got
 * dark form controls even after the user explicitly chose Light in the app.
 * Any control that did not set its own background inherited that and turned
 * into a dark box on a white page.
 *
 * Clearing the inline value (rather than writing `light dark`) is what returns
 * the "System" setting to following the OS again.
 */
export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') {
    root.setAttribute('data-theme', theme);
    root.style.colorScheme = theme;
  } else {
    root.removeAttribute('data-theme');
    root.style.colorScheme = '';
  }
}

/** True when the OS is currently asking for dark. */
export function prefersDark() {
  return (
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(prefers-color-scheme: dark)').matches
  );
}
