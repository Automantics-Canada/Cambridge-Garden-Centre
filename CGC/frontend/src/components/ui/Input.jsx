import React from 'react';
import { cn } from '../../lib/cn';

const FIELD_BASE =
  'w-full bg-surface text-ink border border-control-line rounded-control ' +
  'px-4 h-11 text-sm placeholder:text-muted/70 ' +
  'transition-colors duration-150 ' +
  'hover:border-brand/40 focus:border-brand ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

export function Input({ className, ...props }) {
  return <input className={cn(FIELD_BASE, className)} {...props} />;
}

export function Select({ className, children, ...props }) {
  return (
    <select className={cn(FIELD_BASE, 'pr-9 cursor-pointer', className)} {...props}>
      {children}
    </select>
  );
}

export function Textarea({ className, rows = 4, ...props }) {
  return (
    <textarea
      rows={rows}
      className={cn(FIELD_BASE, 'h-auto py-3 leading-relaxed', className)}
      {...props}
    />
  );
}

/** Label + control + optional help/error text, spaced consistently. */
export function Field({ label, hint, error, htmlFor, className, children }) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <label htmlFor={htmlFor} className="text-[13px] font-medium text-ink">
          {label}
        </label>
      )}
      {children}
      {error ? (
        <p className="text-[12.5px] text-clay">{error}</p>
      ) : hint ? (
        <p className="text-[12.5px] text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export default Input;
