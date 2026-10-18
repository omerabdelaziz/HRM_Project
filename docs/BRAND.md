# Aziz HRM — Brand and design system

## Logo

The mark is an **"A" whose open counter holds a person**: the employee at the heart of the organization. It sits on a navy tile with a faint cyan edge, so the same mark works on light and dark backgrounds.

| File | Use |
|---|---|
| `client/public/logo-mark.svg` | Mark only (app icons, avatars, small spaces) |
| `client/public/logo-light.svg` | Mark + wordmark for light backgrounds (navy "Aziz", royal-blue "HRM") |
| `client/public/logo-dark.svg` | Mark + wordmark for navy/dark backgrounds (white "Aziz", cyan "HRM") |
| `client/public/favicon.svg` | Browser tab |
| `client/src/components/Logo.tsx` | `<LogoMark />` and `<Logo tone="light|dark" />` in the app |
| `server/src/lib/brand.ts` | Vector logo for PDFs (payslips, reports) and the branded email template |

Keep clear space of at least half the mark's width around it. Don't recolor, stretch or add effects. Below 20px, use the mark without the wordmark.

## Colors

| Role | Token | Light | Dark |
|---|---|---|---|
| Primary (navigation, brand) | `navy` | `#102A43` | `#08111D` (sidebar) |
| Action (buttons, links, focus) | `primary` | `#2563EB` | `#2563EB` (links `#93C5FD`) |
| Accent (active indicators, highlights) | `accent` | `#38BDF8` | `#38BDF8` |
| Background | `bg` | `#F5F7FB` | `#0B1421` |
| Cards | `surface` | `#FFFFFF` | `#132238` |
| Text | `ink` | `#1E293B` | `#E2E8F0` |
| Success | `success` | `#16A34A` | `#22C55E` |
| Warning | `warning` | `#F59E0B` | `#F59E0B` |
| Error | `danger` | `#DC2626` | `#EF4444` |

The tokens are defined once in `client/src/index.css` (`:root` and `.dark`) and exposed through Tailwind (`bg-navy`, `text-primary`, `bg-success-soft`…). Components never use raw hex values for themed colors. White text on the royal-blue button meets WCAG AA (5.2:1) in both modes.

**Charts** use a separate categorical palette with slot 1 set to brand royal blue. It was validated for colorblind separation on the light (`#FFFFFF`) and dark (`#132238`) card surfaces; every chart also has a table view. Cyan is a UI accent only: it is too light to carry data on white. Status colors (success, warning, error) are reserved for status and always come with an icon or label.

## Typography and layout

- Inter for Latin script, IBM Plex Sans Arabic for Arabic; Latin digits in both languages for figures.
- Page header: navy icon tile, bold title, muted one-line subtitle, actions on the end side.
- Cards: white, 14px radius, hairline border, soft navy-tinted shadow. KPI tiles: label, colored icon tile, large tabular figure, short caption.
- Controls are 40px high (inputs, selects, pickers and default buttons) with a royal-blue focus ring.
- Tables: uppercase small headers on a tinted row, hover highlight, right-aligned tabular numbers, pagination and sorting.
- Navigation: navy sidebar (collapsible, cyan bar on the active page), white top bar with company switcher, global search (Ctrl+K), language, theme, notifications and profile. All spacing uses logical properties, so the whole layout mirrors for Arabic.

## Notifications (toasts)

All feedback goes through `client/src/lib/toast.tsx`:

| Kind | Color | Used for | Auto-dismiss |
|---|---|---|---|
| Success | green | Create, update, delete, submit, approve, reject, after the server confirms | 4 s |
| Info | blue | Neutral information | 4 s |
| Warning | amber | Completed with caveats (e.g. missing bank details) | 5 s |
| Error | red | Failed operations, with the server's message | 6 s |

Rules:

- Toasts appear at the top of the screen, just below the top bar, slide down, and pause while hovered. Each has a close button and a progress line.
- Success is raised only from a mutation's `onSuccess`, so never before the backend confirms, and never when validation fails.
- An identical message already on screen is refreshed rather than duplicated; at most three are visible.
- `useApiMutation` (`client/src/lib/hooks.ts`) applies this automatically. It also ignores repeat submissions while a request is in flight, and exposes `fieldErrors` so forms wrapped in `<FieldErrors>` show server validation messages beside the matching fields.
