import { cn } from '../lib/cn';

export default function Loader({ message = 'Loading...', size = 'block', className }) {
  if (size === 'inline') {
    return (
      <span
        className={cn(
          'inline-flex items-center justify-center w-4 h-4',
          className
        )}
        aria-hidden
      >
        <span className="w-4 h-4 border-2 border-brand/20 border-t-brand rounded-pill animate-spin" />
      </span>
    );
  }

  return (
    <div className={cn('flex flex-col items-center justify-center p-8 w-full h-full min-h-[200px]', className)}>
      <div className="relative">
        <div className="w-12 h-12 border-4 border-brand/20 border-t-brand rounded-pill animate-spin" />
        <div className="absolute inset-0 w-12 h-12 border-4 border-transparent border-b-brand/40 rounded-pill animate-pulse" />
      </div>
      {message && (
        <p className="mt-4 text-[13px] font-medium text-muted text-center">
          {message}
        </p>
      )}
    </div>
  );
}
