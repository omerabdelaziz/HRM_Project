import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Minimize2, Maximize2 } from 'lucide-react';
import { useGet } from '@/lib/hooks';
import { localized, personName } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/ui/form';
import { Card, EmptyState, PageHeader, Spinner } from '@/components/ui/display';
import { EmployeeAvatar } from '@/components/ui/pickers';
import { Network as PageIcon } from 'lucide-react';

interface Node {
  id: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
  firstNameAr: string | null;
  lastNameAr: string | null;
  photoPath: string | null;
  managerId: string | null;
  position: { title: string; titleAr: string | null } | null;
  department: { id: string; name: string; nameAr: string | null } | null;
}

export default function OrgChart() {
  const { t } = useTranslation();
  const { data, isLoading } = useGet<Node[]>('/org/chart');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const { roots, children, matches } = useMemo(() => {
    const children = new Map<string | null, Node[]>();
    for (const n of data ?? []) children.set(n.managerId, [...(children.get(n.managerId) ?? []), n]);
    const ql = q.trim().toLowerCase();
    const matches = new Set<string>();
    if (ql) for (const n of data ?? []) if (`${n.firstName} ${n.lastName} ${n.firstNameAr ?? ''} ${n.lastNameAr ?? ''} ${n.employeeNo} ${n.position?.title ?? ''}`.toLowerCase().includes(ql)) matches.add(n.id);
    return { roots: children.get(null) ?? [], children, matches };
  }, [data, q]);

  // When searching, expand everything so matches are visible.
  const isCollapsed = (id: string) => !q && collapsed.has(id);
  const toggle = (id: string) => setCollapsed((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  const countAll = (id: string): number => (children.get(id) ?? []).reduce((a, c) => a + 1 + countAll(c.id), 0);

  const render = (n: Node, depth: number) => {
    const kids = children.get(n.id) ?? [];
    return (
      <li key={n.id} className="relative">
        <div className={cn('flex items-center gap-2 rounded-lg py-1.5 pe-2', matches.has(n.id) && 'bg-warning-soft')} style={{ paddingInlineStart: depth ? 12 : 0 }}>
          {kids.length ? (
            <button onClick={() => toggle(n.id)} className="rounded p-0.5 text-ink-3 hover:bg-subtle" aria-expanded={!isCollapsed(n.id)} aria-label={isCollapsed(n.id) ? t('org.expand') : t('org.collapse')}>
              {isCollapsed(n.id) ? <ChevronRight className="h-4 w-4 rtl:rotate-180" /> : <ChevronDown className="h-4 w-4" />}
            </button>
          ) : (
            <span className="w-5" />
          )}
          <Link to={`/employees/${n.id}`} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2 shadow-card hover:border-primary/40">
            <EmployeeAvatar employee={n} size="sm" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{personName(n)}</p>
              <p className="truncate text-xs text-ink-3">
                {[localized(n.position as unknown as Record<string, unknown>, 'title'), localized(n.department as unknown as Record<string, unknown>, 'name')].filter(Boolean).join(' · ')}
              </p>
            </div>
            {kids.length > 0 && <span className="ms-auto shrink-0 rounded-full bg-subtle px-2 text-xs text-ink-2 tabular" title={t('org.teamSize')}>{countAll(n.id)}</span>}
          </Link>
        </div>
        {kids.length > 0 && !isCollapsed(n.id) && <ul className="border-s border-dashed border-line" style={{ marginInlineStart: depth ? 22 : 10 }}>{kids.map((k) => render(k, 1))}</ul>}
      </li>
    );
  };

  return (
    <div>
      <PageHeader icon={<PageIcon />}
        title={t('nav.orgChart')}
        subtitle={data ? t('org.chartSubtitle', { count: data.length }) : undefined}
        actions={
          <>
            <Button size="sm" icon={<Maximize2 className="h-4 w-4" />} onClick={() => setCollapsed(new Set())}>
              {t('org.expandAll')}
            </Button>
            <Button size="sm" icon={<Minimize2 className="h-4 w-4" />} onClick={() => setCollapsed(new Set((data ?? []).filter((n) => children.get(n.id)?.length).map((n) => n.id)))}>
              {t('org.collapseAll')}
            </Button>
          </>
        }
      />
      <Card>
        <SearchInput className="mb-4 max-w-sm" placeholder={t('org.findPerson')} value={q} onChange={(e) => setQ(e.target.value)} />
        {isLoading ? <Spinner /> : !roots.length ? <EmptyState title={t('org.chartEmpty')} /> : <ul className="space-y-1">{roots.map((r) => render(r, 0))}</ul>}
      </Card>
    </div>
  );
}
