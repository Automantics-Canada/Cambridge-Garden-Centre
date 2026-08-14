import React from 'react';
import { cn } from '../../lib/cn';

const VALUE_TONES = {
  default: 'text-ink',
  good: 'text-brand',
  warn: 'text-ochre',
  bad: 'text-clay',
};

/**
 * The big-number tile. This is the signature element of the Greenhouse
 * direction: a quiet label, a very large figure, and one line of context.
 *
 * No icon-in-a-coloured-box. The number is the thing you look at.
 *
 * @param {string} label  - what the number counts
 * @param {string|number} value
 * @param {string} hint   - one short line under the number
 * @param {'default'|'good'|'warn'|'bad'} tone - colours the figure only
 * @param {function} onClick - makes the whole tile a button
 */
export default function StatTile({
  label,
  value,
  hint,
  tone = 'default',
  onClick,
  className,
}) {
  const interactive = typeof onClick === 'function';
  const Tag = interactive ? 'button' : 'div';

  return (
    <Tag
      onClick={onClick}
      className={cn(
        'bg-surface border border-line rounded-card shadow-card',
        'px-6 py-6 text-left w-full flex flex-col',
        interactive &&
          'transition-shadow duration-150 hover:shadow-lift cursor-pointer',
        className
      )}
    >
      <span className="text-[13px] text-muted leading-snug">{label}</span>
      <span
        className={cn(
          'tabular text-stat font-bold mt-3',
          VALUE_TONES[tone] || VALUE_TONES.default
        )}
      >
        {value}
      </span>
      {hint && (
        <span className="text-[12.5px] text-muted mt-2 leading-snug">
          {hint}
        </span>
      )}
    </Tag>
  );
}
