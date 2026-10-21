import type { ReactNode } from 'react';

/**
 * Line icons (24 grid, 1.7 stroke, text color). Emoji look different on each OS and stand out, so we draw our own.
 * The only red is the notification dot on the phone icon — BITL's "your turn" signal.
 */
function Icon({ children, className = 'size-[18px]' }: { children: ReactNode; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={`shrink-0 ${className}`} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

type P = { className?: string };

/** Agent connection: laptop + terminal prompt (same style as step 1 on the landing page) */
export const ConnectIcon = (p: P) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M1.5 19.5h21M7.5 8.5l2.5 2-2.5 2M12 12.5h4" />
  </Icon>
);

export const BellIcon = (p: P) => (
  <Icon {...p}>
    <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
    <path d="M10 20.5a2 2 0 0 0 4 0" />
  </Icon>
);

/** Phone + red notification dot (same shape as the landing page's "see it anywhere, get notified") */
export const PhoneIcon = (p: P) => (
  <Icon {...p}>
    <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
    <path d="M10.5 18.5h3" />
    <circle cx="17" cy="4" r="2.6" className="fill-red-500 stroke-none" />
  </Icon>
);

export const CardIcon = (p: P) => (
  <Icon {...p}>
    <rect x="2.5" y="5" width="19" height="14" rx="2" />
    <path d="M2.5 10h19M6.5 15h4" />
  </Icon>
);

/** Palette — the board theme */
export const PaletteIcon = (p: P) => (
  <Icon {...p}>
    <path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.2-.3-.4-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8z" />
    <circle cx="7.5" cy="11.5" r="1" />
    <circle cx="10.5" cy="7.5" r="1" />
    <circle cx="15" cy="8" r="1" />
  </Icon>
);

/** Open book — the journal (notes left along the way) */
export const JournalIcon = (p: P) => (
  <Icon {...p}>
    <path d="M12 6.5c-2-1.5-5-2-8-1.5v13c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5V5c-3-.5-6 0-8 1.5z" />
    <path d="M12 6.5V20" />
  </Icon>
);

/** Broom — "Clear" (sweep every card off for a fresh start) */
export const BroomIcon = (p: P) => (
  <Icon {...p}>
    <path d="M21 3l-7.5 7.5M10.5 9.5l4 4" />
    <path d="M10.5 9.5C7 10 4.5 12 3 14.5L9.5 21c2.5-1.5 4.5-4 5-7.5" />
    <path d="M6.5 13.5l-1 2.5M9 15.5l-2 3.5" />
  </Icon>
);

export const GlobeIcon = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
  </Icon>
);

/** News: sparkle */
export const NewsIcon = (p: P) => (
  <Icon {...p}>
    <path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z" />
    <path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
  </Icon>
);

/** Download (update) */
export const UpdateIcon = (p: P) => (
  <Icon {...p}>
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </Icon>
);

export const SignOutIcon = (p: P) => (
  <Icon {...p}>
    <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
    <path d="M10 8l-4 4 4 4M6 12h10" />
  </Icon>
);
