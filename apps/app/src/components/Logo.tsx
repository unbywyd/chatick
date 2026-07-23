import { cn } from '@/lib/utils'

// Логотип кодом: галочка — брендовый лайм, текст — currentColor.
// Работает в обеих темах без отдельных ассетов (PNG в public/ — для favicon/OG).
const LIME = '#d4f228'

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" fill="none" className={cn('size-6', className)} aria-hidden>
      {/* speech bubble */}
      <path
        d="M24 4C12.4 4 3 12.7 3 23.5c0 5.4 2.4 10.3 6.2 13.8L8 44l8.4-3.2c2.4.7 4.9 1.2 7.6 1.2 11.6 0 21-8.7 21-19.5S35.6 4 24 4Z"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinejoin="round"
      />
      {/* галочка «тик» */}
      <path
        d="M15 24.5 21 30l12-12"
        stroke={LIME}
        strokeWidth="5.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 text-foreground', className)}>
      <LogoMark />
      <span className="text-base font-bold tracking-tight">Chatick</span>
    </span>
  )
}
