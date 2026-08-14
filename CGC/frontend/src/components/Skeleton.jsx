import React from 'react';
import { cn } from '../lib/cn';

/**
 * A highly reusable Skeleton component for premium loading states.
 */
export function Skeleton({
  className = '',
  variant = 'rectangle', // 'text', 'circular', 'rectangle'
  width,
  height,
  animate = 'pulse' // 'pulse', 'wave', 'none'
}) {
  // Token-based so the placeholder stays subtle in both light and dark.
  const baseStyles = 'bg-ink/[0.07] relative overflow-hidden';

  const variantStyles = {
    text: 'rounded h-4 w-full mb-2',
    circular: 'rounded-pill',
    rectangle: 'rounded-card',
  };

  const animationStyles = {
    pulse: 'animate-pulse',
    wave: 'after:absolute after:inset-0 after:-translate-x-full after:bg-gradient-to-r after:from-transparent after:via-ink/[0.08] after:to-transparent after:animate-[shimmer_2s_infinite]',
    none: '',
  };

  return (
    <div
      className={cn(
        baseStyles,
        variantStyles[variant] || variantStyles.rectangle,
        animationStyles[animate],
        className
      )}
      style={{
        width: width || undefined,
        height: height || undefined,
      }}
    />
  );
}

export function TableSkeleton({ rows = 5, cols = 5 }) {
  return (
    <div className="w-full space-y-4">
      {[...Array(rows)].map((_, i) => (
        <div
          key={i}
          className="flex gap-4 p-4 items-center bg-surface border border-line rounded-control"
        >
          {[...Array(cols)].map((_, j) => (
            <Skeleton
              key={j}
              variant="text"
              className={cn('flex-1', j === 0 && 'max-w-[100px]')}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function CardSkeleton() {
  return (
    <div className="bg-surface p-6 rounded-card border border-line shadow-card space-y-4">
      <Skeleton variant="rectangle" height="200px" />
      <Skeleton variant="text" width="60%" />
      <Skeleton variant="text" width="40%" />
      <div className="flex gap-2">
        <Skeleton variant="circular" width="32px" height="32px" />
        <Skeleton variant="circular" width="32px" height="32px" />
      </div>
    </div>
  );
}

export function SidebarSkeleton() {
  return (
    <div className="w-80 border-r border-line p-6 space-y-6 bg-surface">
      <Skeleton variant="text" width="50%" height="24px" />
      <Skeleton variant="rectangle" height="40px" className="rounded-control" />
      <div className="space-y-3 pt-4">
        {[...Array(8)].map((_, i) => (
          <Skeleton key={i} variant="rectangle" height="80px" className="rounded-card" />
        ))}
      </div>
    </div>
  );
}

export function DriverCardSkeleton() {
  return (
    <div className="bg-surface rounded-card border border-line shadow-card overflow-hidden p-5 space-y-4">
      <div className="flex items-center gap-3">
        <Skeleton variant="circular" width="48px" height="48px" />
        <div className="flex-1 space-y-2">
          <Skeleton variant="text" width="60%" height="16px" />
          <Skeleton variant="text" width="40%" height="12px" />
        </div>
      </div>
      <div className="space-y-2">
        <div className="flex justify-between">
          <Skeleton variant="text" width="30%" height="12px" />
          <Skeleton variant="text" width="30%" height="12px" />
        </div>
        <Skeleton variant="rectangle" height="8px" className="rounded-pill" />
      </div>
      <div className="bg-ink/[0.03] rounded-control p-3 h-20 border border-line flex flex-col justify-center gap-2">
        <Skeleton variant="text" width="20%" height="12px" />
        <Skeleton variant="text" width="80%" height="14px" />
      </div>
      <Skeleton variant="rectangle" height="40px" className="rounded-control" />
    </div>
  );
}

export function DispatchBoardSkeleton({ activeTab = 'unassigned' }) {
  if (activeTab === 'unassigned') {
    return (
      <div className="bg-surface rounded-card shadow-card border border-line overflow-hidden">
        <div className="bg-ink/[0.03] h-12 border-b border-line flex items-center px-6 gap-4">
          <Skeleton variant="text" width="100px" />
          <Skeleton variant="text" width="150px" />
          <Skeleton variant="text" width="150px" />
        </div>
        <div className="divide-y divide-line">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="px-6 py-4 flex items-center gap-4">
              <Skeleton variant="text" width="100px" />
              <Skeleton variant="text" width="150px" />
              <Skeleton variant="text" width="150px" />
              <div className="flex-1" />
              <Skeleton variant="rectangle" width="140px" height="32px" className="rounded-control" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
      {[...Array(4)].map((_, i) => (
        <div key={i} className="bg-surface border border-line rounded-card shadow-card overflow-hidden">
          <div className="bg-ink/[0.03] px-5 py-4 border-b border-line flex justify-between items-center">
            <div className="space-y-2 flex-1">
              <Skeleton variant="text" width="40%" height="18px" />
              <Skeleton variant="text" width="60%" height="12px" />
            </div>
            <Skeleton variant="text" width="40px" height="24px" />
          </div>
          <div className="p-4 space-y-4">
            {[...Array(3)].map((_, j) => (
              <div key={j} className="space-y-2">
                <div className="flex justify-between">
                  <Skeleton variant="text" width="30%" height="14px" />
                  <Skeleton variant="text" width="20%" height="14px" className="rounded-pill" />
                </div>
                <Skeleton variant="text" width="60%" height="12px" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function DeliveryTableSkeleton() {
  return (
    <div className="bg-surface rounded-card shadow-card border border-line overflow-hidden">
      <div className="bg-ink/[0.03] h-14 border-b border-line flex items-center px-6 gap-8">
        <Skeleton variant="text" width="100px" />
        <Skeleton variant="text" width="120px" />
        <Skeleton variant="text" width="100px" />
        <Skeleton variant="text" width="150px" />
      </div>
      <div className="divide-y divide-line">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="px-6 py-5 flex items-center gap-8">
            <div className="space-y-2 w-[100px]">
              <Skeleton variant="text" width="100%" />
              <Skeleton variant="text" width="70%" height="12px" />
            </div>
            <div className="space-y-2 w-[120px]">
              <Skeleton variant="text" width="100%" />
              <Skeleton variant="text" width="60%" height="12px" />
            </div>
            <Skeleton variant="rectangle" width="80px" height="20px" className="rounded-pill" />
            <Skeleton variant="text" width="150px" />
            <div className="flex-1" />
            <Skeleton variant="circular" width="32px" height="32px" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function MobileDriverSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="bg-surface rounded-card p-4 border border-line space-y-3 shadow-card">
        <Skeleton variant="text" width="40%" height="20px" />
        <Skeleton variant="text" width="60%" height="14px" />
      </div>

      <div className="space-y-6">
        <div className="bg-surface rounded-card border border-line p-6 space-y-6 shadow-card">
          <div className="flex justify-between items-start">
            <div className="space-y-2 flex-1">
              <Skeleton variant="text" width="50%" height="20px" />
              <Skeleton variant="text" width="75%" height="14px" />
            </div>
            <Skeleton variant="rectangle" width="80px" height="24px" className="rounded-pill" />
          </div>

          <div className="bg-ink/[0.03] rounded-card p-5 border border-line space-y-4">
            <div className="flex items-center gap-3">
              <Skeleton variant="circular" width="28px" height="28px" />
              <div className="flex-1 space-y-2">
                <Skeleton variant="text" width="40%" height="14px" />
                <Skeleton variant="text" width="30%" height="12px" />
              </div>
            </div>
            <div className="flex items-center gap-3 pt-4 border-t border-line">
              <Skeleton variant="circular" width="28px" height="28px" />
              <div className="flex-1 space-y-2">
                <Skeleton variant="text" width="80%" height="12px" />
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <Skeleton variant="rectangle" height="48px" className="rounded-control" />
            <Skeleton variant="rectangle" height="48px" className="rounded-control" />
          </div>
        </div>
      </div>
    </div>
  );
}
