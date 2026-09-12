export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'ptvault-theme';
/** Must track `--bg` in `theme.css`; it paints the browser chrome around it. */
export const THEME_COLORS: Record<ResolvedTheme, string> = {
  light: '#f2f0ec',
  dark: '#06080b',
};

function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function readStoredTheme(): ThemePreference {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

export function writeStoredTheme(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // The selected theme still applies when browser storage is unavailable.
  }
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
}

export function applyThemePreference(
  preference: ThemePreference,
  systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches,
): ResolvedTheme {
  const resolved = resolveTheme(preference, systemDark);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;

  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.append(meta);
  }
  meta.content = THEME_COLORS[resolved];
  return resolved;
}

export function bootstrapTheme(): ThemePreference {
  const preference = readStoredTheme();
  applyThemePreference(preference);
  return preference;
}
