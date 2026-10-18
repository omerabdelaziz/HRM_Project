import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Megaphone, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation, useGet } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, Textarea } from '@/components/ui/form';
import { Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/display';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { Megaphone as PageIcon } from 'lucide-react';

interface Ann {
  id: string;
  title: string;
  body: string;
  publishedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export default function Announcements() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const confirm = useConfirm();
  const manage = can('announcement.manage');
  const [editing, setEditing] = useState<Partial<Ann> | null>(null);
  const { data, isLoading } = useGet<Ann[]>('/announcements', { all: manage ? 'true' : undefined });
  const remove = useApiMutation((id: string) => api.delete(`/announcements/${id}`), { success: t('common.deleted'), invalidate: ['/announcements'] });
  return (
    <div>
      <PageHeader icon={<PageIcon />}
        title={t('nav.announcements')}
        actions={
          manage && (
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({})}>
              {t('announcements.new')}
            </Button>
          )
        }
      />
      {isLoading ? (
        <Spinner />
      ) : !data?.length ? (
        <Card>
          <EmptyState icon={<Megaphone className="h-6 w-6" />} title={t('announcements.none')} />
        </Card>
      ) : (
        <div className="space-y-4">
          {data.map((a) => (
            <Card key={a.id}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-semibold">{a.title}</h2>
                    {!a.publishedAt && <Badge tone="warning">{t('announcements.draft')}</Badge>}
                    {a.expiresAt && <Badge>{t('announcements.until', { date: fmtDate(a.expiresAt) })}</Badge>}
                  </div>
                  <p className="text-xs text-ink-3">{fmtDate(a.publishedAt ?? a.createdAt)}</p>
                  <p className="mt-3 whitespace-pre-line text-sm text-ink-2">{a.body}</p>
                </div>
                {manage && (
                  <div className="flex shrink-0 gap-1">
                    <Button size="icon" variant="ghost" aria-label={t('common.edit')} icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(a)} />
                    <Button size="icon" variant="ghost" aria-label={t('common.delete')} icon={<Trash2 className="h-4 w-4 text-danger" />} onClick={async () => (await confirm({ title: t('announcements.delete'), message: a.title, tone: 'danger' })) && remove.mutate(a.id)} />
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
      <AnnDialog ann={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function AnnDialog({ ann, onClose }: { ann: Partial<Ann> | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [publish, setPublish] = useState(true);
  const [expires, setExpires] = useState('');
  const [last, setLast] = useState<Partial<Ann> | null>(null);
  if (ann !== last) {
    setLast(ann);
    setTitle(ann?.title ?? '');
    setBody(ann?.body ?? '');
    setPublish(ann ? !ann.id || !!ann.publishedAt : true);
    setExpires(ann?.expiresAt?.slice(0, 10) ?? '');
  }
  const save = useApiMutation(() => {
    const payload = { title, body, publish, expiresAt: expires ? new Date(`${expires}T23:59:59`).toISOString() : null };
    return ann?.id ? api.put(`/announcements/${ann.id}`, payload) : api.post('/announcements', payload);
  }, { success: publish ? t('announcements.published') : t('common.saved'), invalidate: ['/announcements'], onSuccess: onClose });
  return (
    <Dialog open={!!ann} onClose={onClose} title={ann?.id ? t('announcements.edit') : t('announcements.new')} footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" disabled={!title || !body} loading={save.isPending} onClick={() => save.mutate(undefined)}>{publish ? t('announcements.publish') : t('common.save')}</Button></>}>
      <div className="space-y-4">
        <Field label={t('documents.title')} required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label={t('announcements.body')} required>
          <Textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <Field label={t('announcements.expires')}>
          <Input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </Field>
        <Checkbox label={t('announcements.publishNow')} checked={publish} onChange={(e) => setPublish(e.target.checked)} />
      </div>
    </Dialog>
  );
}
