import { useEffect, useState } from 'react';

/**
 * Board themes. The palette lives in index.css as overrides of Tailwind's color variables under
 * html[data-theme=…], plus a few layout touches on hook classes (bitl-card, bitl-empty …) — the components stay as they are.
 *   default   — the usual dark board
 *   zen       — like VS Code's Zen Mode: quiet grays, muted accents, less chrome, a narrower centered board
 *   cyberpunk — neon on violet-black: glowing card edges, clipped corners, scanlines
 * Remembered in this browser only.
 */
export const THEMES = ['default', 'zen', 'cyberpunk'] as const;
export type Theme = (typeof THEMES)[number];

const KEY = 'bitl.theme';
const EVENT = 'bitl:theme';

export function getTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return (THEMES as readonly string[]).includes(v ?? '') ? (v as Theme) : 'default';
  } catch {
    return 'default';
  }
}

/** Puts the theme on <html> (no attribute for the default) */
export function applyTheme(theme: Theme = getTheme()) {
  if (theme === 'default') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

export function setTheme(theme: Theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // this visit only
  }
  applyTheme(theme);
  window.dispatchEvent(new Event(EVENT));
}

export function useTheme(): Theme {
  const [theme, set] = useState(getTheme);
  useEffect(() => {
    const on = () => set(getTheme());
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return theme;
}
