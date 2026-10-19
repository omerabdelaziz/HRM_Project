import { lazy, ReactNode, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ShieldOff } from 'lucide-react';
import { useAuth } from './lib/auth';
import { AppShell } from './components/layout/AppShell';
import { EmptyState, Spinner } from './components/ui/display';
import { Toaster } from './lib/toast';
import Login from './pages/Login';
import ChangePassword from './pages/ChangePassword';

const MfaSetup = lazy(() => import('./pages/MfaSetup'));
const Home = lazy(() => import('./pages/Home'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Account = lazy(() => import('./pages/Account'));
const Notifications = lazy(() => import('./pages/Notifications'));
const Announcements = lazy(() => import('./pages/Announcements'));
const EmployeeList = lazy(() => import('./pages/employees/EmployeeList'));
const EmployeeDetail = lazy(() => import('./pages/employees/EmployeeDetail'));
const Organization = lazy(() => import('./pages/org/Organization'));
const OrgChart = lazy(() => import('./pages/org/OrgChart'));
const Attendance = lazy(() => import('./pages/attendance/Attendance'));
const Leave = lazy(() => import('./pages/leave/Leave'));
const LeaveCalendar = lazy(() => import('./pages/leave/LeaveCalendar'));
const Approvals = lazy(() => import('./pages/approvals/Approvals'));
const ApprovalDetail = lazy(() => import('./pages/approvals/ApprovalDetail'));
const Payroll = lazy(() => import('./pages/payroll/Payroll'));
const RunDetail = lazy(() => import('./pages/payroll/RunDetail'));
const MyPayslips = lazy(() => import('./pages/payroll/MyPayslips'));
const Reports = lazy(() => import('./pages/reports/Reports'));
const Users = lazy(() => import('./pages/admin/Users'));
const Roles = lazy(() => import('./pages/admin/Roles'));
const Workflows = lazy(() => import('./pages/admin/Workflows'));
const Settings = lazy(() => import('./pages/admin/Settings'));
const Audit = lazy(() => import('./pages/admin/Audit'));
const System = lazy(() => import('./pages/admin/System'));

function Guard({ perm, children }: { perm?: string[]; children: ReactNode }) {
  const { can } = useAuth();
  const { t } = useTranslation();
  if (perm && !can(...perm)) return <EmptyState icon={<ShieldOff className="h-6 w-6" />} title={t('common.noAccessTitle')} description={t('common.noAccess')} />;
  return <>{children}</>;
}

export function App() {
  const { me } = useAuth();
  return (
    <>
      <Routed />
      <Toaster belowTopBar={!!me && !me.mustChangePassword && !me.mfaSetupRequired} />
    </>
  );
}

function Routed() {
  const { me, loading } = useAuth();
  const location = useLocation();
  const { t } = useTranslation();
  if (loading) return <Spinner className="h-full" />;
  if (!me) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace state={{ from: location.pathname + location.search }} />} />
      </Routes>
    );
  }
  if (me.mustChangePassword) return <ChangePassword forced />;
  if (me.mfaSetupRequired) return <Suspense fallback={<Spinner className="h-full" />}><MfaSetup /></Suspense>;

  const r = (path: string, el: ReactNode, perm?: string[]) => <Route path={path} element={<Guard perm={perm}>{el}</Guard>} />;
  return (
    <AppShell>
      <Suspense fallback={<Spinner />}>
        <Routes>
          {r('/', <Home />)}
          {r('/dashboard', <Dashboard />, ['dashboard.read'])}
          {r('/account', <Account />)}
          {r('/notifications', <Notifications />)}
          {r('/announcements', <Announcements />)}
          {r('/employees', <EmployeeList />, ['employee.read'])}
          {r('/employees/:id', <EmployeeDetail />)}
          {r('/organization', <Organization />, ['org.manage'])}
          {r('/organization/chart', <OrgChart />, ['employee.read'])}
          {r('/attendance', <Attendance />, ['attendance.self', 'attendance.read'])}
          {r('/leave', <Leave />, ['leave.request', 'leave.read'])}
          {r('/leave/calendar', <LeaveCalendar />, ['leave.read'])}
          {r('/approvals', <Approvals />, ['approval.act'])}
          {r('/approvals/:id', <ApprovalDetail />)}
          {r('/payroll', <Payroll />, ['payroll.read', 'paycomponent.manage'])}
          {r('/payroll/runs/:id', <RunDetail />, ['payroll.read'])}
          {r('/me/payslips', <MyPayslips />, ['payslip.self'])}
          {r('/reports', <Reports />, ['report.read'])}
          {r('/admin/users', <Users />, ['user.manage'])}
          {r('/admin/roles', <Roles />, ['role.manage'])}
          {r('/admin/workflows', <Workflows />, ['workflow.manage'])}
          {r('/admin/settings', <Settings />, ['settings.manage', 'leavetype.manage', 'shift.manage', 'holiday.manage', 'paycomponent.manage'])}
          {r('/admin/audit', <Audit />, ['audit.read'])}
          {r('/admin/system', <System />, ['settings.manage'])}
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="*" element={<EmptyState title={t('common.notFoundTitle')} description={t('common.notFound')} />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}
