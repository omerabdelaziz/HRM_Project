export type Theme = 'light' | 'dark' | 'system';

const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
let current: Theme = 'system';

function paint() {
  const dark = current === 'dark' || (current === 'system' && !!media?.matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

media?.addEventListener('change', () => current === 'system' && paint());

export function applyTheme(theme: Theme) {
  current = theme;
  try {
    localStorage.setItem('hrms.theme', theme);
  } catch {
    /* storage unavailable */
  }
  paint();
}

export function currentTheme(): Theme {
  try {
    return (localStorage.getItem('hrms.theme') as Theme) || 'system';
  } catch {
    return 'system';
  }
}

export const isDark = () => document.documentElement.classList.contains('dark');
