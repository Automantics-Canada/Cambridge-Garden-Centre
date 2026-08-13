import React from 'react';
import { cn } from '../../lib/cn';

const VARIANTS = {
  // Filled green pill — one per screen, for the single most likely action.
  primary:
    'bg-brand text-white hover:brightness-110 active:brightness-95 shadow-card',
  // The everyday button: white surface, hairline border.
  secondary:
    'bg-surface text-ink border border-line hover:bg-brand/[0.06] hover:border-brand/30',
  // No chrome until you touch it. For "View all", toolbar actions.
  ghost:
    'text-muted hover:text-ink hover:bg-ink/[0.05]',
  // Destructive or dispute-related.
  danger:
    'bg-clay text-white hover:brightness-110 active:brightness-95 shadow-card',
  // Quiet destructive, for secondary placement.
  'danger-quiet':
    'text-clay border border-clay/30 hover:bg-clay/10',
};

const SIZES = {
  sm: 'h-9 px-4 text-[13px] gap-1.5',
  md: 'h-11 px-5 text-sm gap-2',
  lg: 'h-12 px-6 text-[15px] gap-2',
  icon: 'h-10 w-10 justify-center',
};

/**
 * The only button in the app. Everything else should be a variant of this.
 *
 * @param {'primary'|'secondary'|'ghost'|'danger'|'danger-quiet'} variant
 * @param {'sm'|'md'|'lg'|'icon'} size
 * @param {React.ElementType} as - render as a different tag, e.g. Link
 */
export default function Button({
  variant = 'secondary',
  size = 'md',
  as: Tag = 'button',
  className,
  children,
  ...props
}) {
  return (
    <Tag
      className={cn(
        'inline-flex items-center justify-center rounded-pill font-semibold',
        'transition-[background-color,border-color,filter,box-shadow] duration-150',
        'disabled:opacity-45 disabled:pointer-events-none whitespace-nowrap',
        VARIANTS[variant],
        SIZES[size],
        className
      )}
      {...props}
    >
      {children}
    </Tag>
  );
}
