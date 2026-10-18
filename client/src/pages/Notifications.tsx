import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CheckCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { useApiMutation, usePaged } from '@/lib/hooks';
import { relativeTime, fmtDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/display';
import { Segmented } from '@/components/ui/nav';
import { Pagination } from '@/components/ui/table';
import { Bell as PageIcon } from 'lucide-react';

interface N {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export default function Notifications() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const list = usePaged<N>('/notifications', { unread: filter === 'unread' ? 'true' : undefined }, { pageSize: 20 });
  const readAll = useApiMutation(() => api.post('/notifications/read-all'), { success: '', invalidate: ['/notifications'] });
  const open = async (n: N) => {
    if (!n.readAt) await api.post(`/notifications/${n.id}/read`);
    list.refetch();
    if (n.link) navigate(n.link);
  };
  return (
    <div>
      <PageHeader icon={<PageIcon />}
        title={t('topbar.notificationsTitle')}
        actions={
          <>
            <Segmented value={filter} onChange={setFilter} options={[{ id: 'all', label: t('common.all') }, { id: 'unread', label: t('notifications.unread') }]} />
            <Button icon={<CheckCheck className="h-4 w-4" />} onClick={() => readAll.mutate(undefined)}>
              {t('topbar.markAllRead')}
            </Button>
          </>
        }
      />
      <Card padded={false}>
        {list.isLoading ? (
          <Spinner />
        ) : !list.data?.items.length ? (
          <EmptyState title={t('topbar.noNotifications')} />
        ) : (
          <ul className="divide-y divide-line">
            {list.data.items.map((n) => (
              <li key={n.id}>
                <button onClick={() => open(n)} className={cn('flex w-full gap-3 px-5 py-3 text-start hover:bg-subtle', !n.readAt && 'bg-primary-soft/30')}>
                  <span className={cn('mt-2 h-2 w-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-primary')} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{n.title}</span>
                      <Badge>{t(`notificationType.${n.type}`)}</Badge>
                    </span>
                    {n.body && <span className="mt-0.5 block text-sm text-ink-2">{n.body}</span>}
                    <span className="mt-0.5 block text-xs text-ink-3" title={fmtDateTime(n.createdAt)}>{relativeTime(n.createdAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {list.data && <Pagination page={list.page} pageCount={list.data.pageCount} total={list.data.total} pageSize={list.pageSize} onPage={list.setPage} />}
      </Card>
    </div>
  );
}
