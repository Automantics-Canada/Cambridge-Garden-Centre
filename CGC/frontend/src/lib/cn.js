import clsx from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge only knows Tailwind's stock class names. Custom scale keys
 * from tailwind.config.js have to be declared, or it guesses wrong — it read
 * `text-stat` as a text *colour*, so `text-ink` silently deleted it and the
 * big dashboard numbers rendered at the default 16px.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['stat'] }],
    },
  },
});

/**
 * Join class names, letting later Tailwind classes beat earlier ones.
 * `cn('p-2', 'p-4')` gives `p-4` instead of both fighting in the CSS.
 */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export default cn;
