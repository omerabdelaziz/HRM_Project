import { useTranslation } from 'react-i18next';
import { Play } from 'lucide-react';
import { api } from '@/lib/api';
import { useApiMutation, useGet, usePaged } from '@/lib/hooks';
import { fmtDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, PageHeader, StatusBadge, Badge } from '@/components/ui/display';
import { DataTable, Pagination } from '@/components/ui/table';
import { Server as PageIcon } from 'lucide-react';

const JOBS = ['backup', 'close-day', 'expiry-reminders', 'escalations', 'scheduled-reports', 'retention'] as const;

export default function System() {
  const { t } = useTranslation();
  const { data: health } = useGet<{ status: string; dbLatencyMs: number; uptimeSec: number; version: string }>('/system/health');
  const list = usePaged<{ id: string; type: string; status: string; startedAt: string | null; finishedAt: string | null; error: string | null; result: unknown }>('/system/jobs', {}, { pageSize: 20 });
  const run = useApiMutation((name: string) => api.post(`/system/jobs/${name}/run`), { success: t('system.jobDone'), invalidate: ['/system/jobs'] });
  return (
    <div className="space-y-6">
      <PageHeader icon={<PageIcon />} title={t('nav.system')} subtitle={t('system.subtitle')} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader title={t('system.health')} />
          {health && (
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-ink-3">{t('common.status')}</dt><dd><Badge tone="success">{health.status}</Badge></dd></div>
              <div className="flex justify-between"><dt className="text-ink-3">{t('system.db')}</dt><dd className="tabular">{health.dbLatencyMs} ms</dd></div>
              <div className="flex justify-between"><dt className="text-ink-3">{t('system.uptime')}</dt><dd className="tabular">{Math.round(health.uptimeSec / 60)} min</dd></div>
              <div className="flex justify-between"><dt className="text-ink-3">{t('system.version')}</dt><dd>{health.version}</dd></div>
            </dl>
          )}
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title={t('system.jobs')} subtitle={t('system.jobsHint')} />
          <div className="grid gap-2 sm:grid-cols-2">
            {JOBS.map((j) => (
              <div key={j} className="flex items-center justify-between gap-3 rounded-lg border border-line p-3">
                <div>
                  <p className="text-sm font-medium">{t(`system.job.${j}`)}</p>
                  <p className="text-xs text-ink-3">{t(`system.jobDesc.${j}`)}</p>
                </div>
                <Button size="sm" icon={<Play className="h-4 w-4" />} loading={run.isPending && run.variables === j} onClick={() => run.mutate(j)}>
                  {t('system.run')}
                </Button>
              </div>
            ))}
          </div>
        </Card>
      </div>
      <Card padded={false}>
        <div className="border-b border-line p-4 font-semibold">{t('system.history')}</div>
        <DataTable
          rows={list.data?.items}
          rowKey={(j) => j.id}
          loading={list.isLoading}
          dense
          columns={[
            { key: 'type', header: t('system.type'), cell: (j) => <span className="font-mono text-xs">{j.type}</span> },
            { key: 'status', header: t('common.status'), cell: (j) => <StatusBadge status={j.status} /> },
            { key: 'start', header: t('system.started'), cell: (j) => fmtDateTime(j.startedAt) },
            { key: 'end', header: t('system.finished'), hideBelow: 'sm', cell: (j) => fmtDateTime(j.finishedAt) },
            { key: 'res', header: t('system.result'), hideBelow: 'md', cell: (j) => <span className="line-clamp-1 font-mono text-xs text-ink-3">{j.error ?? (j.result ? JSON.stringify(j.result) : '')}</span> },
          ]}
        />
        {list.data && <Pagination page={list.page} pageCount={list.data.pageCount} total={list.data.total} pageSize={list.pageSize} onPage={list.setPage} />}
      </Card>
    </div>
  );
}
