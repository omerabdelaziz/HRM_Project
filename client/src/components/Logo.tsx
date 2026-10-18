import { useId } from 'react';
import { cn } from '@/lib/utils';

/**
 * Aziz HRM logo: an "A" whose open counter holds a person — the employee at the
 * heart of the organization. The mark sits on a navy tile so it reads on light and dark
 * surfaces alike; `tone` switches the wordmark color.
 */
export const LOGO_PATHS = {
  // Stroked "A" (white): two legs meeting in a rounded apex.
  frame: 'M16 50 L28.6 17.5 C30 14 34 14 35.4 17.5 L48 50',
  // Person inside the counter (cyan): head and shoulders.
  shoulders: 'M23.5 44 C24.4 38.6 27.9 36 32 36 C36.1 36 39.6 38.6 40.5 44 Z',
  head: { cx: 32, cy: 29.5, r: 4.2 },
};

export function LogoMark({ size = 32, className, title = 'Aziz HRM' }: { size?: number; className?: string; title?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={title} className={cn('shrink-0', className)}>
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1E3A8A" />
          <stop offset="1" stopColor="#102A43" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill={`url(#g${id})`} />
      <rect x="0.75" y="0.75" width="62.5" height="62.5" rx="14.25" fill="none" stroke="#38BDF8" strokeOpacity="0.35" strokeWidth="1.5" />
      <path d={LOGO_PATHS.frame} fill="none" stroke="#FFFFFF" strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle {...LOGO_PATHS.head} fill="#38BDF8" />
      <path d={LOGO_PATHS.shoulders} fill="#38BDF8" />
    </svg>
  );
}

/** Full lockup: mark + "Aziz HRM". tone="light" for light backgrounds, "dark" for navy/dark ones. */
export function Logo({ tone = 'light', size = 32, collapsed, className, subtitle }: { tone?: 'light' | 'dark'; size?: number; collapsed?: boolean; className?: string; subtitle?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark size={size} />
      {!collapsed && (
        <span className="flex flex-col leading-none" dir="ltr">
          <span className={cn('font-semibold tracking-tight', tone === 'dark' ? 'text-white' : 'text-[#102A43] dark:text-white')} style={{ fontSize: size * 0.56 }}>
            Aziz <span className={tone === 'dark' ? 'text-[#38BDF8]' : 'text-[#2563EB] dark:text-[#38BDF8]'}>HRM</span>
          </span>
          {subtitle && <span className={cn('mt-1 whitespace-nowrap text-[10px] font-medium uppercase tracking-[0.12em]', tone === 'dark' ? 'text-white/50' : 'text-ink-3')}>{subtitle}</span>}
        </span>
      )}
    </span>
  );
}
