export default function Loader({ message = 'Loading...' }) {
  return (
    <div className="flex flex-col items-center justify-center p-8 w-full h-full min-h-[200px]">
      <div className="relative">
        <div className="w-12 h-12 border-4 border-[#1B4332]/20 border-t-[#1B4332] rounded-full animate-spin"></div>
        <div className="absolute inset-0 w-12 h-12 border-4 border-transparent border-b-[#1B4332]/40 rounded-full animate-pulse"></div>
      </div>
      {message && (
        <p className="mt-4 text-sm font-bold text-[#1B4332] animate-pulse uppercase tracking-widest text-center">{message}</p>
      )}
    </div>
  );
}
