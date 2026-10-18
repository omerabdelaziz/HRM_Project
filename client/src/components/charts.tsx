// Chart building blocks. Colors come from the validated palette tokens in index.css
// (--series-N, --chart-grid, --chart-axis), so light/dark values swap in one place.
import { ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from 'recharts';
import { BarChart3, Table2 } from 'lucide-react';
import { fmtCompact } from '@/lib/format';
import { isRtl } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Card, CardHeader, EmptyState } from './ui/display';

export const series = (slot: number) => `var(--series-${slot})`;
const GRID = 'var(--chart-grid)';
const AXIS = 'var(--chart-axis)';
const tick = { fill: AXIS, fontSize: 12 };

export interface SeriesDef {
  key: string;
  label: string;
  /** Fixed categorical slot (1–8): color follows the entity, never its rank. */
  slot: number;
}

type Fmt = (v: number) => string;

function ChartTooltip({ active, payload, label, format, labelFormat }: TooltipProps<number, string> & { format: Fmt; labelFormat?: (l: string) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-pop">
      <p className="mb-1 font-medium text-ink">{labelFormat ? labelFormat(String(label)) : label}</p>
      {payload.map((p) => (
        <p key={p.dataKey as string} className="flex items-center gap-2 text-ink-2">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color }} aria-hidden />
          <span>{p.name}</span>
          <span className="ms-auto ps-3 font-medium text-ink tabular">{format(Number(p.value))}</span>
        </p>
      ))}
    </div>
  );
}

function Legend({ items }: { items: SeriesDef[] }) {
  if (items.length < 2) return null;
  return (
    <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
      {items.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: series(s.slot) }} aria-hidden />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

/** Card wrapper with a chart/table toggle so every chart has an accessible table view. */
export function ChartCard({ title, subtitle, children, table, empty, className, actions }: { title: string; subtitle?: string; children: ReactNode; table?: { columns: string[]; rows: (string | number)[][] }; empty?: boolean; className?: string; actions?: ReactNode }) {
  const { t } = useTranslation();
  const [asTable, setAsTable] = useState(false);
  return (
    <Card className={className}>
      <CardHeader
        title={title}
        subtitle={subtitle}
        actions={
          <>
            {actions}
            {table && !empty && (
              <button onClick={() => setAsTable(!asTable)} className="rounded-md p-1.5 text-ink-3 hover:bg-subtle hover:text-ink" aria-label={asTable ? t('charts.showChart') : t('charts.showTable')} title={asTable ? t('charts.showChart') : t('charts.showTable')}>
                {asTable ? <BarChart3 className="h-4 w-4" /> : <Table2 className="h-4 w-4" />}
              </button>
            )}
          </>
        }
      />
      {empty ? (
        <EmptyState title={t('charts.noData')} />
      ) : asTable && table ? (
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-xs text-ink-3">
                {table.columns.map((c, i) => (
                  <th key={c} className={cn('py-2 font-medium', i ? 'text-end' : 'text-start')}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {table.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((v, j) => (
                    <td key={j} className={cn('py-1.5', j ? 'text-end tabular' : 'text-start')}>
                      {v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        children
      )}
    </Card>
  );
}

export function LineSeriesChart<T extends Record<string, unknown>>({ data, x, lines, format = (v) => fmtCompact(v), xFormat, height = 240 }: { data: T[]; x: keyof T & string; lines: SeriesDef[]; format?: Fmt; xFormat?: (v: string) => string; height?: number }) {
  const rtl = isRtl();
  return (
    <div>
      <Legend items={lines} />
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey={x} tick={tick} tickLine={false} axisLine={{ stroke: GRID }} tickFormatter={xFormat} reversed={rtl} minTickGap={16} />
          <YAxis tick={tick} tickLine={false} axisLine={false} tickFormatter={(v) => fmtCompact(v)} width={44} orientation={rtl ? 'right' : 'left'} allowDecimals={false} />
          <Tooltip content={<ChartTooltip format={format} labelFormat={xFormat} />} cursor={{ stroke: AXIS, strokeWidth: 1 }} />
          {lines.map((l) => (
            <Line key={l.key} type="monotone" dataKey={l.key} name={l.label} stroke={series(l.slot)} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" dot={false} activeDot={{ r: 5, stroke: 'var(--chart-surface)', strokeWidth: 2 }} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ColumnChart<T extends Record<string, unknown>>({ data, x, bars, format = (v) => fmtCompact(v), xFormat, height = 240 }: { data: T[]; x: keyof T & string; bars: SeriesDef[]; format?: Fmt; xFormat?: (v: string) => string; height?: number }) {
  const rtl = isRtl();
  return (
    <div>
      <Legend items={bars} />
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }} barGap={2} barCategoryGap="28%">
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey={x} tick={tick} tickLine={false} axisLine={{ stroke: GRID }} tickFormatter={xFormat} reversed={rtl} minTickGap={8} />
          <YAxis tick={tick} tickLine={false} axisLine={false} tickFormatter={(v) => fmtCompact(v)} width={44} orientation={rtl ? 'right' : 'left'} allowDecimals={false} />
          <Tooltip content={<ChartTooltip format={format} labelFormat={xFormat} />} cursor={{ fill: 'var(--chart-grid)', opacity: 0.4 }} />
          {bars.map((b) => (
            <Bar key={b.key} dataKey={b.key} name={b.label} fill={series(b.slot)} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Horizontal ranked bars for one measure (single series → slot 1, no legend).
 * Labels sit outside the bar end in text ink; values are right-aligned.
 */
export function BarList({ items, format = (v) => String(v), max: maxProp, limit = 8 }: { items: { label: string; value: number; sub?: string }[]; format?: Fmt; max?: number; limit?: number }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, limit);
  const max = maxProp ?? Math.max(1, ...items.map((i) => i.value));
  return (
    <div>
      <ul className="space-y-2.5">
        {shown.map((i) => (
          <li key={i.label} className="group" title={`${i.label}: ${format(i.value)}`}>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
              <span className="truncate text-ink-2">{i.label}</span>
              <span className="shrink-0 font-medium text-ink tabular">{format(i.value)}</span>
            </div>
            <div className="h-2.5 w-full">
              <div className="h-full rounded-e-[4px] transition-[width] group-hover:opacity-80" style={{ width: `${Math.max(1.5, (i.value / max) * 100)}%`, background: series(1) }} />
            </div>
          </li>
        ))}
      </ul>
      {items.length > limit && (
        <button onClick={() => setAll(!all)} className="mt-3 text-xs text-primary-ink hover:underline">
          {all ? t('charts.showLess') : t('charts.showAll', { count: items.length })}
        </button>
      )}
    </div>
  );
}
