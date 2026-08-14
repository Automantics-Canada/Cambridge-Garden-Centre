import React from 'react';
import { cn } from '../../lib/cn';

/**
 * A panel. Rounded, hairline border, barely-there shadow — in this direction
 * cards are separated by space and a thin line, not by drop shadows.
 */
export function Card({ className, children, ...props }) {
  return (
    <div
      className={cn(
        'bg-surface border border-line rounded-card shadow-card',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/** Title row for a Card. `action` sits on the right. */
export function CardHeader({ title, subtitle, action, className }) {
  return (
    <div
      className={cn(
        'flex items-center gap-4 px-6 pt-5 pb-4',
        className
      )}
    >
      <div className="min-w-0">
        <h2 className="text-[17px] font-semibold text-ink leading-tight truncate">
          {title}
        </h2>
        {subtitle && (
          <p className="text-[13px] text-muted mt-0.5 truncate">{subtitle}</p>
        )}
      </div>
      {action && <div className="ml-auto flex-none">{action}</div>}
    </div>
  );
}

export function CardBody({ className, children }) {
  return <div className={cn('px-6 pb-6', className)}>{children}</div>;
}

/** Full-width divider that lines up with the card edge. */
export function CardDivider() {
  return <div className="border-t border-line" />;
}

export default Card;
