// Permission catalog and the default system roles. Seeded into the database; roles can be
// edited by administrators afterwards (system roles cannot be deleted).

export const PERMISSIONS = {
  // Organization
  'org.read': ['org', 'View companies, branches, departments, positions'],
  'org.manage': ['org', 'Create and edit organization structure'],
  // Employees
  'employee.read': ['employee', 'View employee profiles within data scope'],
  'employee.create': ['employee', 'Create employees'],
  'employee.update': ['employee', 'Edit employees'],
  'employee.delete': ['employee', 'Archive employees'],
  'employee.import': ['employee', 'Bulk import employees'],
  'employee.export': ['employee', 'Export employees'],
  'employee.sensitive.read': ['employee', 'View national IDs and bank details'],
  'employee.salary.read': ['employee', 'View salary structures'],
  'employee.salary.manage': ['employee', 'Change salary structures'],
  'document.read': ['document', 'View employee documents'],
  'document.manage': ['document', 'Upload and delete employee documents'],
  'document.confidential.read': ['document', 'View confidential documents'],
  // Attendance
  'attendance.read': ['attendance', 'View attendance within data scope'],
  'attendance.manage': ['attendance', 'Create and edit attendance records'],
  'attendance.self': ['attendance', 'Check in/out and request corrections'],
  'shift.manage': ['attendance', 'Manage shifts and assignments'],
  'holiday.manage': ['attendance', 'Manage public holidays'],
  // Leave
  'leave.read': ['leave', 'View leave requests and balances within data scope'],
  'leave.request': ['leave', 'Submit own leave requests'],
  'leave.manage': ['leave', 'Adjust balances and apply leave on behalf of employees'],
  'leavetype.manage': ['leave', 'Configure leave types and policies'],
  // Workflow
  'approval.act': ['workflow', 'Act on approval tasks assigned to me'],
  'approval.read.all': ['workflow', 'View all approval requests'],
  'workflow.manage': ['workflow', 'Configure approval workflows'],
  // Payroll
  'payroll.read': ['payroll', 'View payroll runs and payslips'],
  'payroll.run': ['payroll', 'Create, calculate and adjust payroll runs'],
  'payroll.approve': ['payroll', 'Approve payroll runs'],
  'payroll.pay': ['payroll', 'Mark payroll as paid and export bank files'],
  'payroll.reopen': ['payroll', 'Reopen approved payroll runs'],
  'paycomponent.manage': ['payroll', 'Configure pay components and payroll rules'],
  'payslip.self': ['payroll', 'View own payslips'],
  // Insight
  'dashboard.read': ['insight', 'View the executive dashboard'],
  'report.read': ['insight', 'Run and export reports'],
  // Administration
  'user.manage': ['admin', 'Manage user accounts'],
  'role.manage': ['admin', 'Manage roles and permissions'],
  'settings.manage': ['admin', 'Manage company and system settings'],
  'announcement.manage': ['admin', 'Publish announcements'],
  'audit.read': ['admin', 'View audit logs'],
} as const satisfies Record<string, readonly [string, string]>;

export type PermissionCode = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as PermissionCode[];

export type DataScope = 'ALL' | 'COMPANY' | 'BRANCH' | 'DEPARTMENT' | 'TEAM' | 'SELF';
export const SCOPE_RANK: Record<DataScope, number> = { SELF: 0, TEAM: 1, DEPARTMENT: 2, BRANCH: 3, COMPANY: 4, ALL: 5 };

const SELF_SERVICE: PermissionCode[] = ['attendance.self', 'leave.request', 'payslip.self', 'approval.act', 'org.read'];
const READ_ONLY = ALL_PERMISSIONS.filter((p) => p.endsWith('.read') || p === 'approval.read.all');

export const SYSTEM_ROLES: Record<
  string,
  { name: string; description: string; dataScope: DataScope; permissions: PermissionCode[] }
> = {
  SUPER_ADMIN: {
    name: 'Super Administrator',
    description: 'Full access to every module and setting',
    dataScope: 'ALL',
    permissions: ALL_PERMISSIONS,
  },
  HR_ADMIN: {
    name: 'HR Administrator',
    description: 'Administers HR data, configuration and users',
    dataScope: 'COMPANY',
    permissions: ALL_PERMISSIONS.filter(
      (p) => !['payroll.approve', 'payroll.pay', 'payroll.reopen', 'role.manage'].includes(p),
    ),
  },
  HR_MANAGER: {
    name: 'HR Manager',
    description: 'Manages employees, attendance and leave; approves HR requests',
    dataScope: 'COMPANY',
    permissions: [
      ...SELF_SERVICE,
      'employee.read', 'employee.create', 'employee.update', 'employee.export', 'employee.sensitive.read',
      'employee.salary.read', 'document.read', 'document.manage', 'document.confidential.read',
      'attendance.read', 'attendance.manage', 'shift.manage', 'holiday.manage',
      'leave.read', 'leave.manage', 'leavetype.manage', 'approval.read.all',
      'payroll.read', 'dashboard.read', 'report.read', 'announcement.manage', 'audit.read',
    ],
  },
  PAYROLL_OFFICER: {
    name: 'Payroll Officer',
    description: 'Prepares and calculates payroll',
    dataScope: 'COMPANY',
    permissions: [
      ...SELF_SERVICE,
      'employee.read', 'employee.sensitive.read', 'employee.salary.read', 'employee.salary.manage',
      'attendance.read', 'leave.read', 'payroll.read', 'payroll.run', 'paycomponent.manage',
      'report.read', 'dashboard.read',
    ],
  },
  RECRUITMENT_OFFICER: {
    name: 'Recruitment Officer',
    description: 'Manages vacancies and converts hires into employees',
    dataScope: 'COMPANY',
    permissions: [...SELF_SERVICE, 'employee.read', 'employee.create', 'document.read', 'document.manage', 'report.read'],
  },
  DEPARTMENT_MANAGER: {
    name: 'Department Manager',
    description: 'Manages the departments they lead',
    dataScope: 'DEPARTMENT',
    permissions: [...SELF_SERVICE, 'employee.read', 'attendance.read', 'leave.read', 'dashboard.read', 'report.read'],
  },
  BRANCH_MANAGER: {
    name: 'Branch Manager',
    description: 'Manages the branches they lead',
    dataScope: 'BRANCH',
    permissions: [...SELF_SERVICE, 'employee.read', 'attendance.read', 'leave.read', 'dashboard.read', 'report.read'],
  },
  FINANCE_OFFICER: {
    name: 'Finance Officer',
    description: 'Reviews, approves and pays payroll',
    dataScope: 'COMPANY',
    permissions: [
      ...SELF_SERVICE,
      'employee.read', 'employee.salary.read', 'employee.sensitive.read', 'payroll.read', 'payroll.approve',
      'payroll.pay', 'payroll.reopen', 'report.read', 'dashboard.read',
    ],
  },
  EMPLOYEE: {
    name: 'Employee',
    description: 'Self-service access to own records',
    dataScope: 'SELF',
    permissions: SELF_SERVICE,
  },
  AUDITOR: {
    name: 'Auditor',
    description: 'Read-only access to all records and audit logs',
    dataScope: 'ALL',
    permissions: READ_ONLY,
  },
};
