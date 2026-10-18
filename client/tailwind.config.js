/** @type {import('tailwindcss').Config} */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'IBM Plex Sans Arabic', 'system-ui', 'Segoe UI', 'sans-serif'],
      },
      colors: {
        bg: token('bg'),
        surface: token('surface'),
        subtle: token('subtle'),
        muted: token('muted'),
        line: token('line'),
        navy: { DEFAULT: token('navy'), 2: token('navy-2') },
        accent: token('accent'),
        ink: { DEFAULT: token('ink'), 2: token('ink-2'), 3: token('ink-3') },
        primary: { DEFAULT: token('primary'), fg: token('primary-fg'), soft: token('primary-soft'), ink: token('primary-ink') },
        success: { DEFAULT: token('success'), soft: token('success-soft'), ink: token('success-ink') },
        warning: { DEFAULT: token('warning'), soft: token('warning-soft'), ink: token('warning-ink') },
        danger: { DEFAULT: token('danger'), soft: token('danger-soft'), ink: token('danger-ink') },
        info: { DEFAULT: token('info'), soft: token('info-soft'), ink: token('info-ink') },
      },
      boxShadow: {
        card: '0 1px 2px rgb(16 42 67 / 0.04), 0 2px 8px -2px rgb(16 42 67 / 0.06)',
        lift: '0 4px 6px -2px rgb(16 42 67 / 0.05), 0 12px 24px -8px rgb(16 42 67 / 0.12)',
        pop: '0 16px 40px -12px rgb(16 42 67 / 0.30), 0 4px 12px -4px rgb(16 42 67 / 0.12)',
      },
      borderRadius: { xl: '0.875rem', '2xl': '1.125rem' },
      keyframes: {
        'toast-in': { from: { opacity: '0', transform: 'translateY(-12px) scale(0.98)' }, to: { opacity: '1', transform: 'translateY(0) scale(1)' } },
        'toast-out': { from: { opacity: '1', transform: 'translateY(0)' }, to: { opacity: '0', transform: 'translateY(-8px)' } },
        'toast-progress': { from: { transform: 'scaleX(1)' }, to: { transform: 'scaleX(0)' } },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
      },
      animation: {
        'toast-in': 'toast-in 260ms cubic-bezier(0.21, 1.02, 0.73, 1) both',
        'toast-out': 'toast-out 180ms ease-in both',
        'fade-in': 'fade-in 200ms ease-out both',
      },
    },
  },
  plugins: [],
};
