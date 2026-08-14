import React from 'react';
import { cn } from '../../lib/cn';

/**
 * Shown when a list has nothing in it. Says what happened and what to do —
 * never just "No data".
 */
export default function EmptyState({ icon: Icon, title, message, action, className }) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center px-6 py-14',
        className
      )}
    >
      {Icon && (
        <div className="w-12 h-12 rounded-pill bg-brand/10 flex items-center justify-center mb-4">
          <Icon className="w-5 h-5 text-brand" strokeWidth={1.75} />
        </div>
      )}
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      {message && (
        <p className="text-[13.5px] text-muted mt-1.5 max-w-sm leading-relaxed">
          {message}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
