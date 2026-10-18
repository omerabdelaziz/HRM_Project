import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText } from 'lucide-react';
import { openFile } from '@/lib/api';
import { useGet } from '@/lib/hooks';
import { fmtDate, fmtMoney, fmtMonth } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, PageHeader, Spinner, StatusBadge } from '@/components/ui/display';
import { Drawer } from '@/components/ui/dialog';
import { DataTable } from '@/components/ui/table';
import { PayslipBody, type Slip } from './RunDetail';
import { Receipt as PageIcon } from 'lucide-react';

interface Mine {
  id: string;
  currency: string;
  grossEarnings: string;
  totalDeductions: string;
  netPay: string;
  paymentStatus: string;
  paidAt: string | null;
  run: { year: number; month: number; periodStart: string; periodEnd: string };
}

export default function MyPayslips() {
  const { t } = useTranslation();
  const [open, setOpen] = useState<string | null>(null);
  const { data, isLoading } = useGet<Mine[]>('/payroll/my-payslips');
  const { data: slip, isLoading: loadingSlip } = useGet<Slip>(open ? `/payroll/payslips/${open}` : null);
  return (
    <div>
      <PageHeader icon={<PageIcon />} title={t('nav.myPayslips')} subtitle={t('payroll.mySubtitle')} />
      <Card padded={false}>
        <DataTable
          rows={data}
          loading={isLoading}
          rowKey={(p) => p.id}
          onRowClick={(p) => setOpen(p.id)}
          empty={{ title: t('home.noPayslips') }}
          columns={[
            { key: 'period', header: t('payroll.period'), cell: (p) => <span className="font-medium">{fmtMonth(p.run.year, p.run.month)}</span> },
            { key: 'gross', header: t('payroll.gross'), align: 'end', hideBelow: 'sm', cell: (p) => fmtMoney(p.grossEarnings, p.currency) },
            { key: 'ded', header: t('payroll.deductions'), align: 'end', hideBelow: 'md', cell: (p) => fmtMoney(p.totalDeductions, p.currency) },
            { key: 'net', header: t('payroll.net'), align: 'end', cell: (p) => <span className="font-semibold">{fmtMoney(p.netPay, p.currency)}</span> },
            { key: 'paid', header: t('payroll.payment'), hideBelow: 'sm', cell: (p) => (p.paidAt ? fmtDate(p.paidAt) : <StatusBadge status={p.paymentStatus} />) },
            { key: 'pdf', header: '', align: 'end', cell: (p) => <Button size="sm" variant="ghost" icon={<FileText className="h-4 w-4" />} onClick={(e) => (e.stopPropagation(), openFile(`/payroll/payslips/${p.id}/pdf`))}>{t('payroll.pdf')}</Button> },
          ]}
        />
      </Card>
      {open && (
        <Drawer open onClose={() => setOpen(null)} title={slip ? t('payroll.payslipFor', { period: fmtMonth(Number(data?.find((d) => d.id === open)?.run.year), Number(data?.find((d) => d.id === open)?.run.month)) }) : ''} footer={<Button variant="primary" icon={<FileText className="h-4 w-4" />} onClick={() => openFile(`/payroll/payslips/${open}/pdf`)}>{t('payroll.pdf')}</Button>}>
          {loadingSlip || !slip ? <Spinner /> : <PayslipBody slip={slip} />}
        </Drawer>
      )}
    </div>
  );
}
