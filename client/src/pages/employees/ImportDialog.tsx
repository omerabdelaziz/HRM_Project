import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, FileSpreadsheet, XCircle } from 'lucide-react';
import { toast } from '@/lib/toast';
import { api, download } from '@/lib/api';
import { errorMessage } from '@/lib/hooks';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/display';

interface ImportResult {
  committed: boolean;
  dryRun: boolean;
  summary: { total: number; valid: number; invalid: number };
  rows: { row: number; ok: boolean; errors: string[]; name?: string; employeeNo?: string }[];
}

export function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (dryRun: boolean) => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set('file', file);
      fd.set('dryRun', String(dryRun));
      const r = await api.post<ImportResult>('/employees/import', fd);
      setResult(r);
      if (r.committed) {
        toast.success(t('import.done', { count: r.summary.total }));
        qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('/employees') });
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    setFile(null);
    setResult(null);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      size="lg"
      title={t('import.title')}
      description={t('import.description')}
      footer={
        result?.committed ? (
          <Button variant="primary" onClick={close}>
            {t('common.done')}
          </Button>
        ) : (
          <>
            <Button onClick={close}>{t('common.cancel')}</Button>
            <Button disabled={!file} loading={busy && !result} onClick={() => run(true)}>
              {t('import.validate')}
            </Button>
            <Button variant="primary" disabled={!file || !result || result.summary.invalid > 0} loading={busy && !!result} onClick={() => run(false)}>
              {t('import.importRows', { count: result?.summary.valid ?? 0 })}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        <div className="flex flex-col gap-3 rounded-lg border border-dashed border-line p-4 sm:flex-row sm:items-center">
          <FileSpreadsheet className="h-8 w-8 text-ink-3" aria-hidden />
          <div className="flex-1">
            <input
              type="file"
              accept=".xlsx"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setResult(null);
              }}
              className="block w-full text-sm text-ink-2 file:me-3 file:rounded-lg file:border-0 file:bg-subtle file:px-3 file:py-2 file:text-sm file:font-medium"
            />
            <p className="mt-1 text-xs text-ink-3">{t('import.rules')}</p>
          </div>
          <Button size="sm" variant="ghost" icon={<Download className="h-4 w-4" />} onClick={() => download('/employees/import/template')}>
            {t('import.template')}
          </Button>
        </div>
        {result && (
          <>
            <Alert tone={result.committed ? 'success' : result.summary.invalid ? 'danger' : 'success'}>
              {result.committed
                ? t('import.done', { count: result.summary.total })
                : result.summary.invalid
                  ? t('import.hasErrors', { invalid: result.summary.invalid, total: result.summary.total })
                  : t('import.allValid', { count: result.summary.total })}
            </Alert>
            <div className="max-h-72 overflow-auto rounded-lg border border-line">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-subtle text-xs text-ink-3">
                  <tr>
                    <th className="px-3 py-2 text-start">{t('import.row')}</th>
                    <th className="px-3 py-2 text-start">{t('common.name')}</th>
                    <th className="px-3 py-2 text-start">{t('import.result')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {result.rows.map((r) => (
                    <tr key={r.row}>
                      <td className="px-3 py-2 tabular">{r.row}</td>
                      <td className="px-3 py-2">{r.name}</td>
                      <td className="px-3 py-2">
                        {r.ok ? (
                          <span className="inline-flex items-center gap-1 text-success-ink">
                            <CheckCircle2 className="h-4 w-4" aria-hidden /> {r.employeeNo ?? t('import.valid')}
                          </span>
                        ) : (
                          <span className="inline-flex items-start gap-1 text-danger-ink">
                            <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {r.errors.join('; ')}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
