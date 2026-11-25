/**
 * Design tokens extracted from the Figma file "FOTOMAC (Copy)" (CITEC team).
 * The Figma file uses raw values, not variables, so this is the single place that names
 * them. If CITEC changes the palette, only this file changes.
 *
 * Light and dark mode (28/10/2026): on the web every colour is a CSS variable ("var(--fm-panel-text)"), defined
 * twice — light under :root, dark under :root[data-theme="dark"] (see theme/mode.ts). Switching the mode changes
 * one attribute of the page; no screen re-renders, and the screens keep using panel.text, visitor.surface… The
 * light values are the Figma ones; the dark ones were chosen here. In the app the saved mode picks one at start.
 */
import { Platform } from 'react-native';

import { HIGH_DARK, HIGH_LIGHT } from './a11yData';
import { APP_A11Y } from './appA11y';
import { readPref } from './appPrefs';

const LIGHT: string[] = [];
const DARK: string[] = [];

// The app (06/11/2026): the mode saved in the phone decides the palette when the app starts; switching restarts it.
const APP_DARK = Platform.OS !== 'web' && readPref('fotomac-theme') === 'dark';

// High contrast in the app: the same darker (or lighter, in the dark mode) colours as the site.
const APP_CONTRAST: Record<string, string> | null = APP_A11Y?.contrast ? (APP_DARK ? HIGH_DARK : HIGH_LIGHT) : null;

function themed<T extends Record<string, string>>(group: string, light: T, dark: { [K in keyof T]: string }): T {
  if (Platform.OS !== 'web') {
    const base = (APP_DARK ? dark : light) as Record<string, string>;
    if (!APP_CONTRAST) return base as T;
    return Object.fromEntries(Object.keys(base).map((k) => [k, APP_CONTRAST[`--fm-${group}-${k}`] ?? base[k]])) as T;
  }
  const out: Record<string, string> = {};
  for (const key of Object.keys(light)) {
    const name = `--fm-${group}-${key}`;
    LIGHT.push(`${name}:${light[key]}`);
    DARK.push(`${name}:${dark[key as keyof T]}`);
    out[key] = `var(${name}, ${light[key]})`;   // the light value also as the fallback
  }
  // A palette declared after the stylesheet was installed (a module loaded later) joins it.
  const installed = typeof document !== 'undefined' ? document.getElementById('fotomac-theme') : null;
  if (installed) installed.textContent = themeStylesheet();
  return out as T;
}

/** The stylesheet with both palettes (injected once, at the root). */
export const themeStylesheet = () =>
  `:root{${LIGHT.join(';')};color-scheme:light}:root[data-theme="dark"]{${DARK.join(';')};color-scheme:dark}`;

export const colors = themed('c', {
  primary: '#0070B0',   // was #007DC5 (4.43:1 on white); passes WCAG AA also on the light blue and grey backgrounds (31/10/2026)
  primaryText: '#005F97',
  // Background of filled buttons, under white text (01/11/2026). In the light mode it is the primary blue; in the dark
  // mode the primary is lighter to be read as text on the dark page, and white on it fell to 3.5:1, so the buttons
  // got their own darker blue (4.7:1). One colour cannot do both jobs in the dark mode.
  action: '#0070B0',
  actionHover: '#005F97',
  primarySoft: '#E8F5FC',

  text: '#1E2933',
  textMuted: '#65727E',
  placeholder: '#8A96A0',

  background: '#F6F8FA',
  surface: '#FFFFFF',
  border: '#DDE3E8',
  inputBorder: '#C7D0D8',

  danger: '#C73B47',
  dangerSoft: '#FCECEF',
  success: '#23855B',
  successSoft: '#E8F7F0',
}, {
  primary: '#1A8FD6', primaryText: '#7CC4F0', primarySoft: '#12324A', action: '#1B78BA', actionHover: '#155F94',
  text: '#E6EDF2', textMuted: '#9DAAB5', placeholder: '#6F7E89',
  background: '#0E151C', surface: '#17212B', border: '#2B3A46', inputBorder: '#3A4B58',
  danger: '#F07884', dangerSoft: '#3D1D23', success: '#55C792', successSoft: '#12342A',
});

/** Fonts used by the designs, loaded in src/app/_layout.tsx. */
export const fonts = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semiBold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
  extraBold: 'Inter_800ExtraBold',
  /** The FOTOMAC wordmark next to the camera symbol: "FOTO" regular + "MAC" extra bold. */
  brandRegular: 'Montserrat_400Regular',
  brandBold: 'Montserrat_800ExtraBold',
} as const;

/**
 * Operation area (photographer / administrator). Read from the .fig file: these screens use
 * a slightly different grey scale from the authentication cards above.
 */
export const panel = {
  ...themed('p', {
    text: '#26343D',
    muted: '#5F6F79',     // 4.84:1 on the page grey (31/10/2026, WCAG AA)
    placeholder: '#8A99A3',
    border: '#DDE5EA',
    borderSoft: '#F5F7FA',
    page: '#F5F7F9',
    surface: '#FFFFFF',       // cards, menus, the header
    navText: '#072D44',
    navDivider: '#31536A',
    primary: '#0070B0',
    primaryText: '#00659F',
    primarySoft: '#E8F5FC',
    action: '#0070B0',        // filled buttons under white text (see colors.action)
    success: '#137A57',
    successSoft: '#E8F7F1',
    warning: '#9A6500',
    warningSoft: '#FFF4D6',
    danger: '#C63D4A',
    dangerSoft: '#FDECEF',
    notificationDot: '#FFC506',
  }, {
    text: '#E6EDF2', muted: '#9DAAB5', placeholder: '#6F7E89', border: '#2B3A46', borderSoft: '#1D2933',
    page: '#0E151C', surface: '#17212B', navText: '#E6EDF2', navDivider: '#3A5468',
    primary: '#1A8FD6', primaryText: '#7CC4F0', primarySoft: '#12324A', action: '#1B78BA',
    success: '#55C792', successSoft: '#12342A', warning: '#E7B04F', warningSoft: '#3A2E12',
    danger: '#F07884', dangerSoft: '#3D1D23', notificationDot: '#FFC506',
  }),
  radius: 10,
  cardRadius: 14,
  cardShadow: '0px 2px 8px rgba(24, 55, 72, 0.05)',
};

export { themed };

export const radius = { sm: 8, md: 12, pill: 999 } as const;

export const shadow = {
  // Figma (read from the .fig file): drop shadow 0 2, blur 8, rgba(20,35,47,0.04). boxShadow works on web, iOS and Android
  // (the older shadowColor/shadowOffset props are deprecated in React Native).
  card: { boxShadow: '0px 2px 8px rgba(20, 35, 47, 0.04)' },
} as const;

/**
 * Visitor area (public pages). Read from the .fig file: these screens were drawn
 * for mobile (402 px) with Poppins and an iOS-like grey page; on the web the same column is
 * centred and the event lists widen into a grid.
 */
export const visitor = {
  ...themed('v', {
    page: '#F2F2F7',
    surface: '#FFFFFF',
    title: '#111827',
    heading: '#1F2937',
    text: '#374151',
    muted: '#4B5563',
    placeholder: '#9CA3AF',
    primary: '#0070B0',
    action: '#0070B0',      // filled buttons under white text (see colors.action)
    danger: '#D51C44',
    chip: '#E5E5EA',
    inputBg: 'rgba(5, 27, 59, 0.04)',
    cardBorder: 'rgba(0, 0, 0, 0.10)',
    pillAccent: '#7A5F00',
  }, {
    page: '#0E151C', surface: '#17212B', title: '#F1F5F9', heading: '#E2E8F0', text: '#CBD5E1', muted: '#A3AEBB',
    placeholder: '#6B7785', primary: '#3BA3E3', action: '#1B78BA', danger: '#F07884', chip: '#25323D',
    inputBg: 'rgba(255, 255, 255, 0.06)', cardBorder: 'rgba(255, 255, 255, 0.10)', pillAccent: '#E8C547',
  }),
  overlay: 'rgba(75, 75, 75, 0.53)',
  /** Theme pills alternate between the two institutional accents. */
  pills: [
    { bg: 'rgba(68, 200, 245, 0.20)', fg: '#0070B0' },
    { bg: 'rgba(255, 205, 11, 0.20)', fg: '#CFA70A' },
  ],
  headerShadow: '0px 4px 12px 2px rgba(0, 0, 0, 0.08)',
  cardShadow: '0px 0px 12px rgba(0, 0, 0, 0.12)',
  menuShadow: '0px 0px 6px rgba(0, 0, 0, 0.20)',
  /** Width of the content column on phones/tablets — and of reading pages (privacy, removal). */
  column: 760,
  /** On a computer the visitor area is a WEB page, not a stretched phone screen: from this window width on, the column widens. Phones keep the Figma layout. */
  wideFrom: 1024,
  columnWide: 1200,
};

export const poppins = {
  regular: 'Poppins_400Regular',
  medium: 'Poppins_500Medium',
  semiBold: 'Poppins_600SemiBold',
  bold: 'Poppins_700Bold',
} as const;
