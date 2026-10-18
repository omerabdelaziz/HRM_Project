import { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fmtNumber } from '@/lib/format';
import { EmptyState, ErrorState, Skeleton } from './display';
import { Select } from './form';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Server sort field; makes the header clickable. */
  sort?: string;
  align?: 'start' | 'end' | 'center';
  className?: string;
  /** Hide below this breakpoint to keep tables usable on phones. */
  hideBelow?: 'sm' | 'md' | 'lg';
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  empty?: { title: string; description?: string; action?: ReactNode };
  onRowClick?: (row: T) => void;
  sort?: string;
  onSort?: (s: string) => void;
  selectable?: { selected: Set<string>; onChange: (s: Set<string>) => void; isSelectable?: (row: T) => boolean };
  footer?: ReactNode;
  dense?: boolean;
}

const hide = { sm: 'hidden sm:table-cell', md: 'hidden md:table-cell', lg: 'hidden lg:table-cell' };

export function DataTable<T>({ columns, rows, rowKey, loading, error, onRetry, empty, onRowClick, sort, onSort, selectable, footer, dense }: Props<T>) {
  const { t } = useTranslation();
  const [sortField, sortDir] = (sort ?? '').split(':');
  const toggleSort = (field: string) => onSort?.(sortField === field && sortDir === 'asc' ? `${field}:desc` : `${field}:asc`);
  const selectableRows = rows?.filter((r) => selectable?.isSelectable?.(r) ?? true) ?? [];
  const allSelected = !!selectable && selectableRows.length > 0 && selectableRows.every((r) => selectable.selected.has(rowKey(r)));

  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line bg-subtle text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">
            {selectable && (
              <th className="w-10 px-4 py-2.5">
                <input
                  type="checkbox"
                  aria-label={t('common.selectAll')}
                  checked={allSelected}
                  onChange={(e) => selectable.onChange(new Set(e.target.checked ? selectableRows.map(rowKey) : []))}
                  className="accent-[rgb(var(--primary))]"
                />
              </th>
            )}
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                aria-sort={c.sort && sortField === c.sort ? (sortDir === 'desc' ? 'descending' : 'ascending') : undefined}
                className={cn('px-4 py-2.5 font-medium whitespace-nowrap', c.align === 'end' ? 'text-end' : c.align === 'center' ? 'text-center' : 'text-start', c.hideBelow && hide[c.hideBelow], c.className)}
              >
                {c.sort && onSort ? (
                  <button onClick={() => toggleSort(c.sort!)} className="inline-flex items-center gap-1 uppercase hover:text-ink">
                    {c.header}
                    {sortField === c.sort ? sortDir === 'desc' ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" /> : <ChevronsUpDown className="h-3.5 w-3.5 opacity-50" />}
                  </button>
                ) : (
                  c.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {loading && !rows?.length
            ? Array.from({ length: 6 }).map((_, i) => (
                <tr key={i}>
                  {selectable && <td className="px-4 py-3" />}
                  {columns.map((c) => (
                    <td key={c.key} className={cn('px-4 py-3', c.hideBelow && hide[c.hideBelow])}>
                      <Skeleton className="h-4 w-full max-w-[10rem]" />
                    </td>
                  ))}
                </tr>
              ))
            : rows?.map((row) => {
                const key = rowKey(row);
                const canSelect = selectable?.isSelectable?.(row) ?? true;
                return (
                  <tr
                    key={key}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className={cn('bg-surface transition-colors hover:bg-primary-soft/30', onRowClick && 'cursor-pointer', selectable?.selected.has(key) && 'bg-primary-soft/50')}
                  >
                    {selectable && (
                      <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                        {canSelect && (
                          <input
                            type="checkbox"
                            aria-label={t('common.select')}
                            checked={selectable.selected.has(key)}
                            onChange={(e) => {
                              const next = new Set(selectable.selected);
                              if (e.target.checked) next.add(key);
                              else next.delete(key);
                              selectable.onChange(next);
                            }}
                            className="accent-[rgb(var(--primary))]"
                          />
                        )}
                      </td>
                    )}
                    {columns.map((c) => (
                      <td key={c.key} className={cn('px-4 text-ink', dense ? 'py-2' : 'py-3', c.align === 'end' ? 'text-end tabular' : c.align === 'center' ? 'text-center' : 'text-start', c.hideBelow && hide[c.hideBelow], c.className)}>
                        {c.cell(row)}
                      </td>
                    ))}
                  </tr>
                );
              })}
        </tbody>
        {footer && <tfoot className="border-t-2 border-line bg-subtle/50 font-semibold">{footer}</tfoot>}
      </table>
      {!loading && rows && rows.length === 0 && <EmptyState title={empty?.title ?? t('common.noResults')} description={empty?.description} action={empty?.action} />}
    </div>
  );
}

export function Pagination({ page, pageCount, total, pageSize, onPage, onPageSize }: { page: number; pageCount: number; total: number; pageSize: number; onPage: (p: number) => void; onPageSize?: (s: number) => void }) {
  const { t } = useTranslation();
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex flex-col gap-2 border-t border-line px-4 py-3 text-sm text-ink-2 sm:flex-row sm:items-center sm:justify-between">
      <span className="tabular">{t('common.showing', { from: fmtNumber(from), to: fmtNumber(to), total: fmtNumber(total) })}</span>
      <div className="flex items-center gap-2">
        {onPageSize && (
          <Select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} className="h-8 w-auto" aria-label={t('common.rowsPerPage')}>
            {[10, 25, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n} / {t('common.page')}
              </option>
            ))}
          </Select>
        )}
        <button className="rounded-md border border-line p-1.5 hover:bg-subtle disabled:opacity-40" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={t('common.previous')}>
          <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
        </button>
        <span className="tabular">
          {page} / {Math.max(1, pageCount)}
        </span>
        <button className="rounded-md border border-line p-1.5 hover:bg-subtle disabled:opacity-40" disabled={page >= pageCount} onClick={() => onPage(page + 1)} aria-label={t('common.next')}>
          <ChevronRight className="h-4 w-4 rtl:rotate-180" />
        </button>
      </div>
    </div>
  );
}
