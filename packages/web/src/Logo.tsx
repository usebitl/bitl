/**
 * BITL logo — a broken ring (the flow, a loop) with a red signal in the gap (a task waiting for you).
 * Sources: public/icon.svg (app icon), public/favicon.svg (thicker strokes for small sizes)
 */
export function Logo({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className={className}>
      <rect width="64" height="64" rx="14" fill="#0b0d12" />
      <circle cx="32" cy="32" r="16" fill="none" stroke="#34d399" strokeWidth={size < 28 ? 7 : 6} strokeLinecap="round" strokeDasharray="80 20.53" />
      <circle cx="44.8" cy="22.4" r={size < 28 ? 6 : 5} fill="#f87171" />
    </svg>
  );
}
