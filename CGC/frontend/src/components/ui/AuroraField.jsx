import React from 'react';
import { useReducedMotion } from 'framer-motion';

/**
 * The slow green wash behind the sign-in card.
 *
 * Three large, heavily blurred radial blooms drifting on long offset cycles.
 * Because the periods do not divide evenly (they are 19s, 23s and 29s), the
 * pattern never visibly repeats — a single looped animation reads as a tic
 * once you have watched it for a minute.
 *
 * Colours come from the brand tokens at low alpha, so it follows the theme:
 * a soft tint on the warm light canvas, a deep glow on the dark one.
 *
 * `aria-hidden`, `pointer-events-none`, and completely still under
 * reduced-motion — where it degrades to the same blooms without the drift,
 * keeping the composition rather than dropping to a flat background.
 */
export default function AuroraField() {
  const reduceMotion = useReducedMotion();

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <style>{`
        @keyframes cgc-drift-a {
          0%, 100% { transform: translate3d(-12%, -8%, 0) scale(1); }
          50%      { transform: translate3d(6%, 10%, 0) scale(1.15); }
        }
        @keyframes cgc-drift-b {
          0%, 100% { transform: translate3d(10%, 6%, 0) scale(1.1); }
          50%      { transform: translate3d(-8%, -10%, 0) scale(0.95); }
        }
        @keyframes cgc-drift-c {
          0%, 100% { transform: translate3d(0%, 12%, 0) scale(0.95); }
          50%      { transform: translate3d(-10%, -6%, 0) scale(1.2); }
        }
        @media (prefers-reduced-motion: reduce) {
          .cgc-bloom { animation: none !important; }
        }
      `}</style>

      <div
        className="cgc-bloom absolute -top-1/4 -left-1/4 h-[70vmax] w-[70vmax] rounded-full blur-[90px]"
        style={{
          background:
            'radial-gradient(circle, rgb(var(--c-brand) / 0.22) 0%, transparent 65%)',
          animation: reduceMotion ? 'none' : 'cgc-drift-a 19s ease-in-out infinite',
        }}
      />
      <div
        className="cgc-bloom absolute -bottom-1/3 -right-1/4 h-[65vmax] w-[65vmax] rounded-full blur-[100px]"
        style={{
          background:
            'radial-gradient(circle, rgb(var(--c-brand) / 0.16) 0%, transparent 65%)',
          animation: reduceMotion ? 'none' : 'cgc-drift-b 23s ease-in-out infinite',
        }}
      />
      <div
        className="cgc-bloom absolute top-1/4 right-1/4 h-[45vmax] w-[45vmax] rounded-full blur-[80px]"
        style={{
          background:
            'radial-gradient(circle, rgb(var(--c-ochre) / 0.10) 0%, transparent 70%)',
          animation: reduceMotion ? 'none' : 'cgc-drift-c 29s ease-in-out infinite',
        }}
      />
    </div>
  );
}
