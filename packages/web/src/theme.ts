import { useEffect, useLayoutEffect, useState } from 'react';

/**
 * Board themes: a style and a mode (light or dark), chosen separately. The palette lives in index.css as overrides of
 * Tailwind's color variables under html[data-theme=…] (and [data-mode='light'] for the light versions), plus a few
 * layout touches on hook classes (bitl-card, bitl-empty …) — the components stay as they are.
 *   default   — the original board ("Loop")
 *   cyberpunk — neon yellow on black, cyan and hot pink accents: glowing card edges, clipped corners, scanlines.
 *               Light: a daylight deck — paper, black lines, yellow/cyan/pink as fills instead of glow
 *   zine      — the default: a cut-and-paste zine: halftone paper, cards as stickers (thick ink border, hard offset shadow),
 *               column titles on tape, square corners; yellow = running, cyan = needs review, hot pink = waiting on you
 * Dark mode is <html class="dark"> (the components' dark: styles); light drops it. Remembered in this browser only.
 * The style is put on <html> only while a board is on screen (useBoardTheme), so the site's other pages keep their look.
 */
/** In menu order; a stored theme that is no longer here (the old 'zen') falls back to the first */
export const THEMES = ['zine', 'default', 'cyberpunk'] as const;
export type Theme = (typeof THEMES)[number];
export const MODES = ['dark', 'light'] as const;
export type Mode = (typeof MODES)[number];

const KEY = 'bitl.theme';
const MODE_KEY = 'bitl.mode';
const EVENT = 'bitl:theme';

function read<T extends string>(key: string, values: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return (values as readonly string[]).includes(v ?? '') ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

export const getTheme = (): Theme => read(KEY, THEMES, 'zine');
export const getMode = (): Mode => read(MODE_KEY, MODES, 'dark');

/** Puts the theme and mode on <html> (no data-theme for the default style, no data-mode for dark) */
export function applyTheme(theme: Theme = getTheme(), mode: Mode = getMode()) {
  const html = document.documentElement;
  if (theme === 'default') delete html.dataset.theme;
  else html.dataset.theme = theme;
  if (mode === 'dark') delete html.dataset.mode;
  else html.dataset.mode = mode;
  html.classList.toggle('dark', mode === 'dark');
}

function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // this visit only
  }
  applyTheme();
  window.dispatchEvent(new Event(EVENT));
}

export const setTheme = (theme: Theme) => save(KEY, theme);
export const setMode = (mode: Mode) => save(MODE_KEY, mode);

function useStored<T>(get: () => T): T {
  const [value, set] = useState(get);
  useEffect(() => {
    const on = () => set(get());
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, [get]);
  return value;
}

export const useTheme = (): Theme => useStored(getTheme);
export const useMode = (): Mode => useStored(getMode);

/** Puts the chosen style on <html> while the board is mounted, and takes it off again when it goes (mode stays) */
export function useBoardTheme() {
  useLayoutEffect(() => {
    applyTheme();
    return () => applyTheme('default');
  }, []);
}
