import React, { useEffect, useState } from 'react';
import { Sun, Moon } from 'lucide-react';
import { cn } from '../../lib/cn';
import { applyTheme, getStoredTheme, storeTheme, prefersDark } from '../../lib/theme';

export default function ThemeToggle({ className }) {
  const [theme, setTheme] = useState(() => getStoredTheme());

  useEffect(() => {
    applyTheme(theme);
    storeTheme(theme);
  }, [theme]);

  // With no saved choice we do not know which way the OS is leaning without
  // asking it, so ask.
  const isDark = theme === 'dark' || (theme === null && prefersDark());

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
