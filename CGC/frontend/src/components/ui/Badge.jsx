import React from 'react';
import { cn } from '../../lib/cn';

const TONES = {
  good: 'bg-brand/12 text-brand',
  warn: 'bg-ochre/20 text-ochre',
  bad: 'bg-clay/14 text-clay',
  neutral: 'bg-ink/[0.06] text-muted',
};

/** A status chip. Soft tinted pill — never a hard, saturated block. */
export function Badge({ tone = 'neutral', className, children }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-pill px-3 py-1',
        'text-[12px] font-semibold leading-none whitespace-nowrap',
        TONES[tone] || TONES.neutral,
        className
      )}
    >
      {children}
    </span>
  );
}

/**
 * Single source of truth for how a backend status looks and reads.
 * Add new statuses here rather than writing colour logic inside a page.
 */
const STATUS_MAP = {
  VERIFIED: { tone: 'good', label: 'Verified' },
  APPROVED: { tone: 'good', label: 'Approved' },
  MATCHED: { tone: 'good', label: 'Matched' },
  DELIVERED: { tone: 'good', label: 'Delivered' },
  COMPLETED: { tone: 'good', label: 'Completed' },
  LINKED: { tone: 'good', label: 'Linked' },

  PENDING_REVIEW: { tone: 'warn', label: 'Pending review' },
  PENDING: { tone: 'warn', label: 'Pending' },
  IN_TRANSIT: { tone: 'warn', label: 'In transit' },
  PROCESSING: { tone: 'warn', label: 'Processing' },
  ASSIGNED: { tone: 'warn', label: 'Assigned' },
  UNLINKED: { tone: 'warn', label: 'Unlinked' },
  UNASSIGNED: { tone: 'warn', label: 'Unassigned' },
  RATE_UNKNOWN: { tone: 'warn', label: 'Rate unknown' },
  NO_TICKET: { tone: 'warn', label: 'No ticket' },
  NO_ORDER: { tone: 'warn', label: 'No order' },

  DISPUTED: { tone: 'bad', label: 'Disputed' },
  FAILED: { tone: 'bad', label: 'Failed' },
  REJECTED: { tone: 'bad', label: 'Rejected' },
  CANCELLED: { tone: 'bad', label: 'Cancelled' },
  RATE_MISMATCH: { tone: 'bad', label: 'Rate mismatch' },
  QTY_MISMATCH: { tone: 'bad', label: 'Qty mismatch' },
  MULTIPLE_FLAGS: { tone: 'bad', label: 'Multiple flags' },

  PLACED: { tone: 'neutral', label: 'Placed' },
};

/** Turns `PENDING_REVIEW` into a readable, correctly coloured chip. */
export function StatusBadge({ status, className }) {
  if (!status) return null;
  const key = String(status).toUpperCase();
  const found = STATUS_MAP[key];
  const label = found?.label || key.replace(/_/g, ' ').toLowerCase();

  return (
    <Badge tone={found?.tone || 'neutral'} className={cn('capitalize', className)}>
      {label}
    </Badge>
  );
}

export default Badge;
