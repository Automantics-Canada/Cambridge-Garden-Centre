import clsx from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Join class names, letting later Tailwind classes beat earlier ones.
 * `cn('p-2', 'p-4')` gives `p-4` instead of both fighting in the CSS.
 */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export default cn;
