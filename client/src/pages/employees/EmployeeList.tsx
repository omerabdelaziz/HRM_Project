import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Download, FileSpreadsheet, Plus, Upload } from 'lucide-react';
import { toast } from '@/lib/toast';
import { download } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage, usePaged } from '@/lib/hooks';
import { localized, personName } from '@/lib/i18n';
import { fmtDate } from '@/lib/format';
import { EMPLOYEE_STATUSES, type Employee } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { SearchInput, Select } from '@/components/ui/form';
import { Card, PageHeader, StatusBadge } from '@/components/ui/display';
import { Column, DataTable, Pagination } from '@/components/ui/table';
import { OrgSelect, PersonCell } from '@/components/ui/pickers';
import { EmployeeFormDialog } from './EmployeeForm';
import { ImportDialog } from './ImportDialog';
import { Users as PageIcon } from 'lucide-react';

export default function EmployeeList() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [departmentId, setDept] = useState<string | null>(null);
  const [branchId, setBranch] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
  const [includeSeparated, setIncludeSeparated] = useState(false);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const statusFilter = status ? [status] : includeSeparated ? undefined : ['PROBATION', 'ACTIVE', 'SUSPENDED'];
  const list = usePaged<Employee>('/employees', { departmentId, branchId, status: statusFilter }, { sort: 'employeeNo:asc' });
  const { setSearch } = list;
  useEffect(() => {
    const s = params.get('search');
    if (s) setSearch(s);
    if (params.get('new') === '1' && can('employee.create')) setCreating(true);
  }, [params, setSearch, can]);

  const exportXlsx = async () => {
    try {
      await download('/employees/export', { departmentId, branchId, status: statusFilter, search: list.search || undefined });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const columns: Column<Employee>[] = [
    { key: 'name', header: t('common.employee'), sort: 'firstName', cell: (e) => <PersonCell employee={e} /> },
    { key: 'position', header: t('common.position'), sort: 'position.title', hideBelow: 'md', cell: (e) => localized(e.position as unknown as Record<string, unknown>, 'title') || '—' },
    { key: 'department', header: t('common.department'), sort: 'department.name', hideBelow: 'sm', cell: (e) => localized(e.department as unknown as Record<string, unknown>, 'name') || '—' },
    { key: 'branch', header: t('common.branch'), hideBelow: 'lg', cell: (e) => localized(e.branch as unknown as Record<string, unknown>, 'name') || '—' },
    { key: 'manager', header: t('common.manager'), hideBelow: 'lg', cell: (e) => (e.manager ? personName(e.manager) : '—') },
    { key: 'hireDate', header: t('employees.hireDate'), sort: 'hireDate', hideBelow: 'md', cell: (e) => fmtDate(e.hireDate) },
    { key: 'status', header: t('common.status'), sort: 'status', cell: (e) => <StatusBadge status={e.status} /> },
  ];

  return (
    <div>
      <PageHeader icon={<PageIcon />}
        title={t('nav.employees')}
        subtitle={list.data ? t('employees.count', { count: list.data.total }) : undefined}
        actions={
          <>
            {can('employee.import') && (
              <Button icon={<Upload className="h-4 w-4" />} onClick={() => setImporting(true)}>
                {t('employees.import')}
              </Button>
            )}
            {can('employee.export') && (
              <Button icon={<Download className="h-4 w-4" />} onClick={exportXlsx}>
                {t('common.exportExcel')}
              </Button>
            )}
            {can('employee.create') && (
              <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
                {t('employees.add')}
              </Button>
            )}
          </>
        }
      />
      <Card padded={false}>
        <div className="flex flex-col gap-3 border-b border-line p-4 lg:flex-row lg:items-center">
          <SearchInput className="lg:max-w-xs flex-1" placeholder={t('employees.searchPlaceholder')} value={list.search} onChange={(e) => list.setSearch(e.target.value)} aria-label={t('common.search')} />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:flex">
            <OrgSelect entity="departments" value={departmentId} onChange={setDept} placeholder={t('employees.allDepartments')} />
            <OrgSelect entity="branches" value={branchId} onChange={setBranch} placeholder={t('employees.allBranches')} />
            <Select value={status} onChange={(e) => setStatus(e.target.value)} placeholder={t('employees.currentStaff')} aria-label={t('common.status')}>
              {EMPLOYEE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`status.${s}`)}
                </option>
              ))}
            </Select>
            {!status && (
              <label className="flex items-center gap-2 text-sm text-ink-2 whitespace-nowrap">
                <input type="checkbox" checked={includeSeparated} onChange={(e) => setIncludeSeparated(e.target.checked)} className="accent-[rgb(var(--primary))]" />
                {t('employees.includeSeparated')}
              </label>
            )}
          </div>
        </div>
        <DataTable
          columns={columns}
          rows={list.data?.items}
          rowKey={(e) => e.id}
          loading={list.isLoading}
          error={list.error}
          onRetry={() => list.refetch()}
          sort={list.sort}
          onSort={list.setSort}
          onRowClick={(e) => navigate(`/employees/${e.id}`)}
          empty={{
            title: t('employees.none'),
            description: list.search ? t('employees.noneSearch') : t('employees.noneHint'),
            action: can('employee.create') ? (
              <Button variant="primary" icon={<FileSpreadsheet className="h-4 w-4" />} onClick={() => setCreating(true)}>
                {t('employees.add')}
              </Button>
            ) : undefined,
          }}
        />
        {list.data && <Pagination page={list.page} pageCount={list.data.pageCount} total={list.data.total} pageSize={list.pageSize} onPage={list.setPage} onPageSize={list.setPageSize} />}
      </Card>
      <EmployeeFormDialog open={creating} onClose={() => setCreating(false)} onSaved={(e) => !e.temporaryPassword && navigate(`/employees/${e.id}`)} />
      <ImportDialog open={importing} onClose={() => setImporting(false)} />
    </div>
  );
}
