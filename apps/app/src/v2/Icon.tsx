/**
 * Иконки макета — те же контуры, что на холсте, штрихом в цвет текста.
 * Класс .ic задаёт размер и толщину (styles/main.css).
 */
const PATHS: Record<string, React.ReactNode> = {
  chevron: <path d="M6 9l6 6 6-6" />,
  chevronEnd: <path d="M9 6l6 6-6 6" />,
  chevronStart: <path d="M14.5 6l-6 6 6 6" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  people: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8" />
      <path d="M16 5.2a3 3 0 010 5.6M18 14.6c1.4.7 2.3 2.2 2.6 4.4" />
    </>
  ),
  pause: <path d="M9 5v14M15 5v14" />,
  play: <path d="M8 5.5v13l11-6.5z" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.2-4.2" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  bell: (
    <>
      <path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15z" />
      <path d="M10 20.5a2 2 0 004 0" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c.8-3.5 3.6-5.5 7-5.5s6.2 2 7 5.5" />
    </>
  ),
  spark: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />,
  building: <path d="M4 20V8l8-4 8 4v12M9 20v-6h6v6" />,
  logout: <path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1.4" fill="currentColor" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" />
      <circle cx="19" cy="12" r="1.4" fill="currentColor" />
    </>
  ),
  expand: <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />,
  share: (
    <>
      <path d="M12 4v11M7.5 8.5L12 4l4.5 4.5" />
      <path d="M5 13v5a2 2 0 002 2h10a2 2 0 002-2v-5" />
    </>
  ),
  fire: <path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 01-10 0c0-2.5 1.5-4 2.5-5 .3 1.6 1 2.6 2 3 .5-2.6-.5-5.5.5-8z" />,
  arrow: <path d="M5 12h13M13 6l6 6-6 6" />,
  ask: (
    <>
      <path d="M5 18.5V6a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H8.5z" />
      <path d="M10 8.5a2 2 0 113 1.7c-.6.4-1 .9-1 1.6M12 14h.01" />
    </>
  ),
  hand: (
    <path d="M8 13V5.5a1.5 1.5 0 013 0V11m0-1.5V4a1.5 1.5 0 013 0v7m0-5a1.5 1.5 0 013 0v7.5a6.5 6.5 0 01-11.6 4L4 14.5a1.6 1.6 0 012.4-2L8 14" />
  ),
  cancel: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M6 6l12 12" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  attach: <path d="M20 11.5l-7.8 7.8a5 5 0 01-7.1-7.1l8.5-8.5a3.3 3.3 0 014.7 4.7l-8.5 8.5a1.6 1.6 0 01-2.3-2.3l7.8-7.8" />,
  send: <path d="M12 19V5M6 11l6-6 6 6" />,
  sidebar: <path d="M4 5h16v14H4zM15 5v14" />,
  grid: <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />,
  sort: <path d="M7 10l5-5 5 5M7 14l5 5 5-5" />,
  hourglass: <path d="M6.5 3h11M6.5 21h11M8 3v3.5a4 4 0 004 4 4 4 0 014 4V21M16 3v3.5a4 4 0 01-4 4 4 4 0 00-4 4V21" />,
  target: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  reopen: <path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4" />,
  calendar: (
    <>
      <rect x="4" y="5.5" width="16" height="14.5" rx="2.5" />
      <path d="M8 3.5v4M16 3.5v4M4 10h16" />
    </>
  ),
  back: <path d="M9 14l-4-4 4-4M5 10h9a5 5 0 010 10h-2" />,
  list: <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />,
  folders: (
    <>
      <path d="M3.5 7.5a2 2 0 012-2h3.2l1.8 2h8a2 2 0 012 2v7a2 2 0 01-2 2h-13a2 2 0 01-2-2z" />
      <path d="M3.5 10.5h17" />
    </>
  ),
  sliders: <path d="M4 7h10M18 7h2M4 17h4M12 17h8M14 5v4M8 15v4" />,
  grip: (
    <>
      <circle cx="9" cy="6" r="1.3" fill="currentColor" />
      <circle cx="15" cy="6" r="1.3" fill="currentColor" />
      <circle cx="9" cy="12" r="1.3" fill="currentColor" />
      <circle cx="15" cy="12" r="1.3" fill="currentColor" />
      <circle cx="9" cy="18" r="1.3" fill="currentColor" />
      <circle cx="15" cy="18" r="1.3" fill="currentColor" />
    </>
  ),
  plane: (
    <>
      <path d="M21 3L10 14" />
      <path d="M21 3l-7 18-4-7-7-4z" />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M18 14v4a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h4" />
    </>
  ),
  download: <path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14" />,
  mail: (
    <>
      <path d="M4 6h16v12H4z" />
      <path d="M4 7l8 6 8-6" />
    </>
  ),
  archive: <path d="M4 7h16v3H4zM5.5 10v9h13v-9M10 14h4" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z" />,
  monitor: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
  lang: <path d="M4 5h9M8.5 3v2M6 5c.5 3 3 6 6.5 7.5M11 5c-.8 3.5-3.6 6.6-7 8M13 21l4.5-10L22 21M14.5 17.5h6" />,
}

export type IconName = keyof typeof PATHS

export function Icon({ name, sm, fill, style }: { name: IconName | string; sm?: boolean; fill?: boolean; style?: React.CSSProperties }) {
  return (
    <svg className={'ic' + (sm ? ' sm' : '') + (fill ? ' fl' : '')} viewBox="0 0 24 24" aria-hidden="true" style={style}>
      {PATHS[name]}
    </svg>
  )
}
