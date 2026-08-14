import React from 'react';
import { cn } from '../../lib/cn';

/**
 * Every page opens the same way: large title, one line of plain-language
 * context, actions on the right. Consistency here is most of what makes an
 * app feel designed rather than assembled.
 */
export default function PageHeader({ title, subtitle, actions, className }) {
  return (
    <header
      className={cn(
        'flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between',
        className
      )}
    >
      <div className="min-w-0">
        <h1 className="text-[30px] font-bold text-ink tracking-[-0.015em] leading-tight">
          {title}
        </h1>
        {subtitle && (
          <p className="text-sm text-muted mt-1.5 max-w-2xl">{subtitle}</p>
        )}
      </div>
      {actions && (
        <div className="flex items-center gap-2 flex-none">{actions}</div>
      )}
    </header>
  );
}
