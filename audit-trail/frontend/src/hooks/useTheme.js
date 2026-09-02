import { useEffect, useState } from 'react';

/**
 * The one place the application's theme is decided, stored and read.
 *
 * The theme itself lives where CSS can see it - `data-theme` on the document
 * element - so every rule in `app.css` and every CSS module can respond to it
 * with a variable override rather than a JavaScript branch. This module is the
 * small amount of glue that is genuinely unavoidable:
 *
 *  - the layout needs to *set* it (and remember the choice);
 *  - the charts need to *read* it, because SVG is drawn with attributes and a
 *    `stroke` attribute cannot resolve a CSS variable.
 *
 * `CHART_PALETTE` therefore mirrors the tokens in `app.css` deliberately, and is
 * the only mirror: before this existed, `SensorChart` and `StatusDashboard`
 * each carried their own private list of hex codes, which is why one of them
 * drifted into looking like a different application.
 */

export const THEME_KEY = 'audit-trail-theme';

export const THEMES = Object.freeze({ DARK: 'dark', LIGHT: 'light' });

/**
 * The saved choice, else the system preference, else the dark control-room
 * default this interface was designed around.
 */
export function getInitialTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === THEMES.LIGHT || saved === THEMES.DARK) return saved;
  } catch {
    // Ignore storage access issues and fall back to the system preference.
  }

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? THEMES.LIGHT : THEMES.DARK;
  }

  return THEMES.DARK;
}

/** Publishes the theme to CSS and remembers it. */
export function applyTheme(theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // A browser with storage disabled still themes correctly for this page.
  }
}

/**
 * The current theme, kept in step with whatever set it.
 *
 * It watches the attribute rather than taking the value as a prop, so a
 * component several levels below the layout - a chart inside a panel inside a
 * page - responds to the toggle without the theme having to be threaded through
 * everything in between, and without a second context provider that tests would
 * then have to wrap around every render.
 */
export function useTheme() {
  const [theme, setTheme] = useState(() =>
    typeof document === 'undefined' ? THEMES.DARK : document.documentElement.dataset.theme || getInitialTheme()
  );

  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return undefined;

    const root = document.documentElement;
    const read = () => setTheme(root.dataset.theme || THEMES.DARK);

    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });

    return () => observer.disconnect();
  }, []);

  return theme;
}

/**
 * Chart colours, per theme.
 *
 * These mirror the CSS tokens of the same name. The signal colours keep their
 * meaning across both themes - amber is a breach and only ever a breach, violet
 * means a lifecycle event - and only their lightness changes, because a stroke
 * that reads well on the dark hull is too pale to see on white.
 */
export const CHART_PALETTE = Object.freeze({
  dark: Object.freeze({
    teal: '#34c3b0',
    amber: '#f0a13c',
    violet: '#8f7ceb',
    red: '#e8615d',
    green: '#5ec27a',
    blue: '#4a9bf0',
    axis: '#6f8497',
    grid: '#1e2d3d',
    text: '#e6edf4',
    textDim: '#a9bbcc',
    surface: '#16222f',
    border: '#26384a',
  }),
  light: Object.freeze({
    teal: '#0f7a70',
    amber: '#a8641a',
    violet: '#5b46c4',
    red: '#bd3a34',
    green: '#2f8f4e',
    blue: '#1f6fc4',
    axis: '#61758b',
    grid: '#d8e1ec',
    text: '#1b2a36',
    textDim: '#425466',
    surface: '#ffffff',
    border: '#d8e1ec',
  }),
});

/** The palette for the theme currently in force. */
export function useChartPalette() {
  const theme = useTheme();
  return CHART_PALETTE[theme] ?? CHART_PALETTE.dark;
}
