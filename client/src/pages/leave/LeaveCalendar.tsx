import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useGet } from '@/lib/hooks';
import { localized, personName } from '@/lib/i18n';
import { fmtMonth } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, PageHeader, Spinner } from '@/components/ui/display';
import { OrgSelect } from '@/components/ui/pickers';
import { CalendarCheck as PageIcon } from 'lucide-react';

interface Entry {
  id: string;
  startDate: string;
  endDate: string;
  status: string;
  halfDay: boolean;
  leaveType: { name: string; nameAr: string | null; color: string };
  employee: { id: string; firstName: string; lastName: string; firstNameAr: string | null; lastNameAr: string | null; department: { name: string } | null };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export default function LeaveCalendar() {
  const { t } = useTranslation();
  const { company } = useAuth();
  const now = new Date();
  const [ym, setYm] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [departmentId, setDept] = useState<string | null>(null);
  const first = new Date(Date.UTC(ym.y, ym.m, 1));
  const last = new Date(Date.UTC(ym.y, ym.m + 1, 0));
  const { data = [], isLoading } = useGet<Entry[]>('/leave/calendar', { from: iso(first), to: iso(last), departmentId });
  const days = Array.from({ length: last.getUTCDate() }, (_, i) => new Date(Date.UTC(ym.y, ym.m, i + 1)));
  const weekend = company?.weekendDays ?? [5, 6];

  const people = useMemo(() => {
    const m = new Map<string, { emp: Entry['employee']; entries: Entry[] }>();
    for (const e of data) {
      const g = m.get(e.employee.id) ?? { emp: e.employee, entries: [] };
      g.entries.push(e);
      m.set(e.employee.id, g);
    }
    return [...m.values()].sort((a, b) => personName(a.emp).localeCompare(personName(b.emp)));
  }, [data]);

  const move = (delta: number) => setYm(({ y, m }) => ({ y: m + delta < 0 ? y - 1 : m + delta > 11 ? y + 1 : y, m: (m + delta + 12) % 12 }));
  const todayIso = iso(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));

  return (
    <div>
      <PageHeader icon={<PageIcon />}
        title={t('nav.leaveCalendar')}
        subtitle={t('leave.calendarSubtitle')}
        actions={
          <div className="flex items-center gap-2">
            <div className="w-56">
              <OrgSelect entity="departments" value={departmentId} onChange={setDept} placeholder={t('employees.allDepartments')} />
            </div>
            <Button size="icon" onClick={() => move(-1)} aria-label={t('common.previous')} icon={<ChevronLeft className="h-4 w-4 rtl:rotate-180" />} />
            <span className="min-w-[9rem] text-center font-medium">{fmtMonth(ym.y, ym.m + 1)}</span>
            <Button size="icon" onClick={() => move(1)} aria-label={t('common.next')} icon={<ChevronRight className="h-4 w-4 rtl:rotate-180" />} />
          </div>
        }
      />
      <Card padded={false}>
        {isLoading ? (
          <Spinner />
        ) : !people.length ? (
          <p className="py-12 text-center text-sm text-ink-3">{t('leave.calendarEmpty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  <th className="sticky start-0 z-10 min-w-[11rem] border-b border-line bg-surface px-3 py-2 text-start font-medium text-ink-3">{t('common.employee')}</th>
                  {days.map((d) => (
                    <th key={d.getUTCDate()} className={cn('w-8 border-b border-line px-0.5 py-2 text-center font-medium tabular', weekend.includes(d.getUTCDay()) ? 'bg-subtle text-ink-3' : 'text-ink-2', iso(d) === todayIso && 'text-primary-ink')}>
                      {d.getUTCDate()}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {people.map(({ emp, entries }) => (
                  <tr key={emp.id} className="border-b border-line">
                    <td className="sticky start-0 z-10 bg-surface px-3 py-1.5">
                      <p className="truncate text-sm font-medium">{personName(emp)}</p>
                      <p className="truncate text-ink-3">{emp.department?.name}</p>
                    </td>
                    {days.map((d) => {
                      const day = iso(d);
                      const hit = entries.find((e) => e.startDate.slice(0, 10) <= day && e.endDate.slice(0, 10) >= day);
                      return (
                        <td key={day} className={cn('h-10 px-0.5', weekend.includes(d.getUTCDay()) && 'bg-subtle')}>
                          {hit && (
                            <div
                              title={`${localized(hit.leaveType as unknown as Record<string, unknown>, 'name')} · ${t(`status.${hit.status}`)}`}
                              className={cn('mx-auto h-6 rounded', hit.halfDay ? 'w-1/2' : 'w-full', hit.status === 'PENDING' && 'opacity-50 [background-image:repeating-linear-gradient(45deg,transparent,transparent_3px,rgb(255_255_255/0.5)_3px,rgb(255_255_255/0.5)_6px)]')}
                              style={{ backgroundColor: hit.leaveType.color }}
                            />
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-4 border-t border-line px-4 py-3 text-xs text-ink-2">
          {[...new Map(data.map((e) => [e.leaveType.name, e.leaveType])).values()].map((lt) => (
            <span key={lt.name} className="inline-flex items-center gap-1.5">
              <span className="h-3 w-3 rounded" style={{ background: lt.color }} aria-hidden />
              {localized(lt as unknown as Record<string, unknown>, 'name')}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5">
            <span className="h-3 w-3 rounded bg-ink-3 opacity-50" aria-hidden /> {t('leave.pendingHatched')}
          </span>
        </div>
      </Card>
    </div>
  );
}
