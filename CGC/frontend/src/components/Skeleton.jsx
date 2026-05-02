import React from 'react';

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
  const baseStyles = "bg-gray-200 relative overflow-hidden";
  
  const variantStyles = {
    text: "rounded-md h-4 w-full mb-2",
    circular: "rounded-full",
    rectangle: "rounded-2xl"
  };

  const animationStyles = {
    pulse: "animate-pulse",
    wave: "after:absolute after:inset-0 after:-translate-x-full after:bg-gradient-to-r after:from-transparent after:via-white/20 after:to-transparent after:animate-[shimmer_2s_infinite]",
    none: ""
  };

  const combinedClassName = `
    ${baseStyles} 
    ${variantStyles[variant] || variantStyles.rectangle} 
    ${animationStyles[animate]} 
    ${className}
  `.trim();

  return (
    <div 
      className={combinedClassName} 
      style={{ 
        width: width || undefined, 
        height: height || undefined 
      }}
    />
  );
}

export function TableSkeleton({ rows = 5, cols = 5 }) {
  return (
    <div className="w-full space-y-4">
      {[...Array(rows)].map((_, i) => (
        <div key={i} className="flex gap-4 p-4 items-center bg-white border border-gray-100 rounded-xl">
          {[...Array(cols)].map((_, j) => (
            <Skeleton key={j} variant="text" className={`flex-1 ${j === 0 ? 'max-w-[100px]' : ''}`} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function CardSkeleton() {
  return (
    <div className="bg-white p-6 rounded-[40px] border border-gray-100 shadow-sm space-y-4">
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
    <div className="w-80 border-r p-6 space-y-6 bg-white">
      <Skeleton variant="text" width="50%" height="24px" />
      <Skeleton variant="rectangle" height="40px" className="rounded-xl" />
      <div className="space-y-3 pt-4">
        {[...Array(8)].map((_, i) => (
          <Skeleton key={i} variant="rectangle" height="80px" className="rounded-2xl" />
        ))}
      </div>
    </div>
  );
}

export function DriverCardSkeleton() {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden p-5 space-y-4">
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
        <Skeleton variant="rectangle" height="8px" className="rounded-full" />
      </div>
      <div className="bg-gray-50 rounded-lg p-3 h-20 border border-gray-100 flex flex-col justify-center gap-2">
        <Skeleton variant="text" width="20%" height="10px" />
        <Skeleton variant="text" width="80%" height="14px" />
      </div>
      <Skeleton variant="rectangle" height="40px" className="rounded-lg" />
    </div>
  );
}

export function DispatchBoardSkeleton({ activeTab = 'unassigned' }) {
  if (activeTab === 'unassigned') {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="bg-gray-50 h-12 border-b border-gray-200 flex items-center px-6 gap-4">
          <Skeleton variant="text" width="100px" />
          <Skeleton variant="text" width="150px" />
          <Skeleton variant="text" width="150px" />
        </div>
        <div className="divide-y divide-gray-100">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="px-6 py-4 flex items-center gap-4">
              <Skeleton variant="text" width="100px" />
              <Skeleton variant="text" width="150px" />
              <Skeleton variant="text" width="150px" />
              <div className="flex-1" />
              <Skeleton variant="rectangle" width="140px" height="32px" className="rounded-lg" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
      {[...Array(4)].map((_, i) => (
        <div key={i} className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
          <div className="bg-gray-50 px-5 py-4 border-b border-gray-100 flex justify-between items-center">
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
                  <Skeleton variant="text" width="20%" height="14px" className="rounded-full" />
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
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
      <div className="bg-gray-50 h-14 border-b border-gray-200 flex items-center px-6 gap-8">
        <Skeleton variant="text" width="100px" />
        <Skeleton variant="text" width="120px" />
        <Skeleton variant="text" width="100px" />
        <Skeleton variant="text" width="150px" />
      </div>
      <div className="divide-y divide-gray-100">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="px-6 py-5 flex items-center gap-8">
            <div className="space-y-2 w-[100px]">
              <Skeleton variant="text" width="100%" />
              <Skeleton variant="text" width="70%" height="10px" />
            </div>
            <div className="space-y-2 w-[120px]">
              <Skeleton variant="text" width="100%" />
              <Skeleton variant="text" width="60%" height="10px" />
            </div>
            <Skeleton variant="rectangle" width="80px" height="20px" className="rounded-full" />
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
    <div className="min-h-screen bg-gray-950 p-4 space-y-4">
      <div className="bg-gray-900/80 rounded-2xl p-4 border border-gray-800 space-y-2">
        <Skeleton className="bg-gray-800" variant="text" width="40%" height="24px" />
        <Skeleton className="bg-gray-800" variant="text" width="60%" height="16px" />
      </div>
      <div className="space-y-4 pt-4">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="bg-gray-900 rounded-2xl border border-gray-800 p-5 space-y-4">
            <div className="flex justify-between items-start">
              <div className="space-y-2 flex-1">
                <Skeleton className="bg-gray-800" variant="text" width="50%" height="20px" />
                <Skeleton className="bg-gray-800" variant="text" width="70%" height="14px" />
              </div>
              <Skeleton className="bg-gray-800" variant="rectangle" width="80px" height="24px" className="rounded" />
            </div>
            <Skeleton className="bg-gray-800" variant="rectangle" height="60px" className="rounded-xl" />
            <div className="space-y-3">
              <Skeleton className="bg-gray-800" variant="rectangle" height="48px" className="rounded-xl" />
              <Skeleton className="bg-gray-800" variant="rectangle" height="48px" className="rounded-xl" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
