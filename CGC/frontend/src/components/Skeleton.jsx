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
