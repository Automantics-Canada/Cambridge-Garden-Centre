import React, { useEffect, useState } from 'react';
import { Sun, Moon } from 'lucide-react';
import { cn } from '../../lib/cn';

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

/** Applies a theme by stamping the root element, which the tokens react to. */
export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') {
    root.setAttribute('data-theme', theme);
  } else {
    root.removeAttribute('data-theme');
  }
}

export default function ThemeToggle({ className }) {
  const [theme, setTheme] = useState(() => getStoredTheme());

  useEffect(() => {
    applyTheme(theme);
    try {
      if (theme) localStorage.setItem(KEY, theme);
      else localStorage.removeItem(KEY);
    } catch {
      /* private browsing — the toggle still works for this session */
    }
  }, [theme]);

  // With no saved choice we do not know which way the OS is leaning without
  // asking it, so ask.
  const isDark =
    theme === 'dark' ||
    (theme === null &&
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-color-scheme: dark)').matches);

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      title={isDark ? 'Switch to light' : 'Switch to dark'}
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      className={cn(
        'w-10 h-10 rounded-pill flex items-center justify-center flex-none',
        'text-muted hover:text-ink hover:bg-ink/[0.05] transition-colors',
        className
      )}
    >
      {isDark ? <Sun size={18} strokeWidth={1.75} /> : <Moon size={18} strokeWidth={1.75} />}
    </button>
  );
}
