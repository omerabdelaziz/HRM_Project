/* Demo company built through the real services (validation, numbering, history, workflows, payroll). */
import type { PrismaClient } from '@prisma/client';
import { prisma as appPrisma } from '../src/lib/prisma';
import { loadAuthUser } from '../src/auth/context';
import { hashPassword } from '../src/auth/passwords';
import { createEmployee } from '../src/modules/employees/service';
import { createLeaveRequest } from '../src/modules/leave/service';
import { recalculateRecord } from '../src/modules/attendance/service';
import { employeeCalendar } from '../src/modules/attendance/calendar';
import { decide } from '../src/modules/workflow/engine';
import { proposeSalary, createRun, calculateRun, submitRun, markPaid } from '../src/modules/payroll/service';
import { addDays, isoDate, toDateOnly, zonedTimeToUtc } from '../src/lib/dates';
import { luhnValid } from '../../shared/validation';
import '../src/modules/attendance/service';

// Deterministic PRNG so every demo database looks the same.
let seed = 20261016;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
const between = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));

const DEMO_PASSWORD = 'Demo@12345';

/** A well-formed Emirates ID (784-YYYY-NNNNNNN-C) with a valid Luhn check digit. */
function emiratesId(year: number, serial: number) {
  const body = `784${year}${String(serial).padStart(7, '0')}`;
  for (let c = 0; c <= 9; c++) if (luhnValid(body + c)) return `784-${year}-${String(serial).padStart(7, '0')}-${c}`;
  throw new Error('unreachable');
}
const TZ = 'Asia/Dubai';

const PEOPLE: [string, string, string, string, 'MALE' | 'FEMALE', string][] = [
  ['Omar', 'Al Mansoori', 'عمر', 'المنصوري', 'MALE', 'AE'], ['Layla', 'Haddad', 'ليلى', 'حداد', 'FEMALE', 'JO'], ['Ahmed', 'Khalil', 'أحمد', 'خليل', 'MALE', 'EG'],
  ['Fatima', 'Al Zaabi', 'فاطمة', 'الزعابي', 'FEMALE', 'AE'], ['Rahul', 'Menon', 'راهول', 'مينون', 'MALE', 'IN'], ['Sara', 'Nasser', 'سارة', 'ناصر', 'FEMALE', 'LB'],
  ['Khalid', 'Al Suwaidi', 'خالد', 'السويدي', 'MALE', 'AE'], ['Maria', 'Santos', 'ماريا', 'سانتوس', 'FEMALE', 'PH'], ['Youssef', 'Bennani', 'يوسف', 'بناني', 'MALE', 'MA'],
  ['Noura', 'Al Hashimi', 'نورة', 'الهاشمي', 'FEMALE', 'AE'], ['James', 'Carter', 'جيمس', 'كارتر', 'MALE', 'GB'], ['Hana', 'Saleh', 'هناء', 'صالح', 'FEMALE', 'SY'],
  ['Tariq', 'Rahman', 'طارق', 'رحمن', 'MALE', 'PK'], ['Aisha', 'Al Marri', 'عائشة', 'المري', 'FEMALE', 'AE'], ['Daniel', 'Okafor', 'دانيال', 'أوكافور', 'MALE', 'NG'],
  ['Mona', 'Farouk', 'منى', 'فاروق', 'FEMALE', 'EG'], ['Hassan', 'Darwish', 'حسن', 'درويش', 'MALE', 'JO'], ['Priya', 'Nair', 'بريا', 'ناير', 'FEMALE', 'IN'],
  ['Saeed', 'Al Ketbi', 'سعيد', 'الكتبي', 'MALE', 'AE'], ['Reem', 'Abdallah', 'ريم', 'عبدالله', 'FEMALE', 'SD'], ['Ali', 'Hussain', 'علي', 'حسين', 'MALE', 'IQ'],
  ['Grace', 'Mensah', 'غريس', 'منساه', 'FEMALE', 'GH'], ['Majid', 'Al Falasi', 'ماجد', 'الفلاسي', 'MALE', 'AE'], ['Lina', 'Kassem', 'لينا', 'قاسم', 'FEMALE', 'LB'],
  ['Arjun', 'Pillai', 'أرجون', 'بيلاي', 'MALE', 'IN'], ['Dana', 'Al Nuaimi', 'دانة', 'النعيمي', 'FEMALE', 'AE'], ['Karim', 'Mostafa', 'كريم', 'مصطفى', 'MALE', 'EG'],
  ['Elena', 'Petrova', 'إيلينا', 'بتروفا', 'FEMALE', 'RU'], ['Faisal', 'Al Shamsi', 'فيصل', 'الشامسي', 'MALE', 'AE'], ['Rania', 'Yousef', 'رانيا', 'يوسف', 'FEMALE', 'PS'],
  ['Imran', 'Qureshi', 'عمران', 'قريشي', 'MALE', 'PK'], ['Salma', 'Idris', 'سلمى', 'إدريس', 'FEMALE', 'SD'], ['Bilal', 'Hamdan', 'بلال', 'حمدان', 'MALE', 'JO'],
  ['Joy', 'Reyes', 'جوي', 'رييس', 'FEMALE', 'PH'], ['Mahmoud', 'Zaki', 'محمود', 'زكي', 'MALE', 'EG'], ['Shamma', 'Al Mazrouei', 'شمة', 'المزروعي', 'FEMALE', 'AE'],
  ['Victor', 'Haddad', 'فيكتور', 'حداد', 'MALE', 'LB'], ['Amal', 'Bakr', 'أمل', 'بكر', 'FEMALE', 'EG'], ['Nikhil', 'Rao', 'نيخيل', 'راو', 'MALE', 'IN'],
  ['Huda', 'Al Qasimi', 'هدى', 'القاسمي', 'FEMALE', 'AE'],
];

export async function seedDemo(db: PrismaClient) {
  if (await db.company.findUnique({ where: { code: 'ACME' } })) {
    console.log('• Demo company already exists, skipping');
    return;
  }
  const adminUser = await db.user.findUniqueOrThrow({ where: { email: (process.env.SEED_ADMIN_EMAIL ?? 'admin@hrms.local').toLowerCase() } });
  const today = toDateOnly(new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()));

  // ── Company & organization ──
  const company = await db.company.create({
    data: {
      code: 'ACME', name: 'Acme Trading LLC', nameAr: 'شركة أكمي للتجارة ذ.م.م', legalName: 'Acme Trading L.L.C.', registrationNo: 'CN-1234567', taxNo: '100123456700003',
      email: 'hr@acme.example', phone: '+971 4 123 4567', address: 'Business Bay, Dubai, United Arab Emirates', baseCurrency: 'AED', timezone: TZ, locale: 'en',
      weekendDays: [0, 6], employeeNoPrefix: 'ACM', employeeNoPadding: 4, probationMonths: 6,
      payrollSettings: { create: { dailyRateBasis: 'FIXED_30', rateBase: 'BASIC', overtimeMultiplier: 1.25, weekendOvertimeMultiplier: 1.5, holidayOvertimeMultiplier: 1.5, deductUnpaidLeave: true, deductAbsence: true, paymentDay: 27, companyBankAccount: 'AE070331234567890123456' } },
      attendancePolicy: { create: { minOvertimeMinutes: 30, overtimeRequiresApproval: false, halfDayThresholdMinutes: 240 } },
    },
  });
  const cid = company.id;
  const branches = Object.fromEntries(
    await Promise.all(
      [['DXB', 'Dubai HQ', 'المقر الرئيسي - دبي', 'Dubai'], ['AUH', 'Abu Dhabi', 'أبوظبي', 'Abu Dhabi'], ['SHJ', 'Sharjah Warehouse', 'مستودع الشارقة', 'Sharjah']].map(async ([code, name, nameAr, city]) => [
        code,
        await db.branch.create({ data: { companyId: cid, code, name, nameAr, city, country: 'AE' } }),
      ]),
    ),
  );
  const ccs = Object.fromEntries(await Promise.all(['ADMIN', 'SALES', 'OPS', 'TECH'].map(async (code) => [code, await db.costCenter.create({ data: { companyId: cid, code, name: `${code[0]}${code.slice(1).toLowerCase()} cost center` } })])));
  const deptDefs: [string, string, string, string, string][] = [
    ['EXEC', 'Executive Office', 'الإدارة التنفيذية', 'DXB', 'ADMIN'], ['HR', 'Human Resources', 'الموارد البشرية', 'DXB', 'ADMIN'], ['FIN', 'Finance', 'المالية', 'DXB', 'ADMIN'],
    ['IT', 'Information Technology', 'تقنية المعلومات', 'DXB', 'TECH'], ['SALES', 'Sales', 'المبيعات', 'AUH', 'SALES'], ['OPS', 'Operations & Logistics', 'العمليات والخدمات اللوجستية', 'SHJ', 'OPS'],
    ['CS', 'Customer Service', 'خدمة العملاء', 'DXB', 'SALES'],
  ];
  const depts: Record<string, { id: string }> = {};
  for (const [code, name, nameAr, br, cc] of deptDefs) depts[code] = await db.department.create({ data: { companyId: cid, code, name, nameAr, branchId: branches[br].id, costCenterId: ccs[cc].id } });

  const grades = Object.fromEntries(
    await Promise.all(
      [['G1', 'Associate', 1, 4000, 9000], ['G2', 'Specialist', 2, 8000, 16000], ['G3', 'Senior', 3, 14000, 26000], ['G4', 'Manager', 4, 22000, 40000], ['G5', 'Executive', 5, 35000, 80000]].map(
        // Managerial and executive grades are not paid overtime.
        async ([code, name, level, min, max]) => [code, await db.jobGrade.create({ data: { companyId: cid, code: code as string, name: name as string, level: level as number, minSalary: min as number, maxSalary: max as number, overtimeEligible: (level as number) < 4 } })],
      ),
    ),
  );
  const posDefs: [string, string, string, string, string, number][] = [
    ['CEO', 'Chief Executive Officer', 'الرئيس التنفيذي', 'EXEC', 'G5', 1], ['HRM', 'HR Manager', 'مدير الموارد البشرية', 'HR', 'G4', 1], ['HRS', 'HR Specialist', 'أخصائي موارد بشرية', 'HR', 'G2', 3],
    ['FINM', 'Finance Manager', 'المدير المالي', 'FIN', 'G4', 1], ['ACC', 'Accountant', 'محاسب', 'FIN', 'G2', 3], ['PAYO', 'Payroll Officer', 'مسؤول الرواتب', 'FIN', 'G2', 1],
    ['ITM', 'IT Manager', 'مدير تقنية المعلومات', 'IT', 'G4', 1], ['DEV', 'Software Engineer', 'مهندس برمجيات', 'IT', 'G3', 5], ['SUP', 'IT Support Specialist', 'أخصائي دعم فني', 'IT', 'G1', 2],
    ['SALM', 'Sales Manager', 'مدير المبيعات', 'SALES', 'G4', 1], ['SALE', 'Sales Executive', 'تنفيذي مبيعات', 'SALES', 'G2', 8], ['OPSM', 'Operations Manager', 'مدير العمليات', 'OPS', 'G4', 1],
    ['WH', 'Warehouse Supervisor', 'مشرف مستودع', 'OPS', 'G2', 2], ['DRV', 'Logistics Coordinator', 'منسق لوجستي', 'OPS', 'G1', 6], ['CSM', 'Customer Service Lead', 'قائد خدمة العملاء', 'CS', 'G3', 1],
    ['CSA', 'Customer Service Agent', 'موظف خدمة عملاء', 'CS', 'G1', 6], ['REC', 'Recruitment Officer', 'مسؤول التوظيف', 'HR', 'G2', 1],
  ];
  const positions: Record<string, { id: string; departmentId: string | null; gradeId: string | null }> = {};
  for (const [code, title, titleAr, dept, grade, headcount] of posDefs) {
    positions[code] = await db.position.create({ data: { companyId: cid, code, title, titleAr, departmentId: depts[dept].id, gradeId: grades[grade].id, headcount } });
  }
  const cats = Object.fromEntries(await Promise.all([['NATIONAL', 'UAE National', 'مواطن'], ['EXPAT', 'Expatriate', 'وافد']].map(async ([code, name, nameAr]) => [code, await db.employeeCategory.create({ data: { companyId: cid, code, name, nameAr } })])));
  const types = Object.fromEntries(await Promise.all([['FULL_TIME', 'Full time', 'دوام كامل'], ['PART_TIME', 'Part time', 'دوام جزئي'], ['CONTRACT', 'Fixed-term contract', 'عقد محدد المدة']].map(async ([code, name, nameAr]) => [code, await db.employmentType.create({ data: { companyId: cid, code, name, nameAr } })])));

  // ── Time & leave configuration ──
  const dayShift = await db.shift.create({ data: { companyId: cid, code: 'DAY', name: 'Day shift 09:00–18:00', nameAr: 'الدوام النهاري', startTime: '09:00', endTime: '18:00', breakMinutes: 60, graceMinutes: 15, workDays: [1, 2, 3, 4, 5], isDefault: true } });
  const whShift = await db.shift.create({ data: { companyId: cid, code: 'WH', name: 'Warehouse 07:00–16:00', nameAr: 'دوام المستودع', startTime: '07:00', endTime: '16:00', breakMinutes: 60, graceMinutes: 10, workDays: [1, 2, 3, 4, 5, 6] } });
  await db.shift.create({ data: { companyId: cid, code: 'NIGHT', name: 'Night 22:00–06:00', nameAr: 'الدوام الليلي', startTime: '22:00', endTime: '06:00', breakMinutes: 45, graceMinutes: 10, workDays: [1, 2, 3, 4, 5] } });
  await db.shift.create({ data: { companyId: cid, code: 'FLEX', name: 'Flexible (8h/day)', nameAr: 'دوام مرن', startTime: '07:00', endTime: '19:00', breakMinutes: 60, isFlexible: true, requiredMinutes: 480, workDays: [1, 2, 3, 4, 5] } });

  const year = today.getUTCFullYear();
  for (const [m, d, name, nameAr] of [[1, 1, "New Year's Day", 'رأس السنة الميلادية'], [12, 2, 'National Day', 'اليوم الوطني'], [12, 3, 'National Day Holiday', 'عطلة اليوم الوطني'], [12, 1, 'Commemoration Day', 'يوم الشهيد']] as const) {
    for (const y of [year, year + 1]) await db.holiday.create({ data: { companyId: cid, date: new Date(Date.UTC(y, m - 1, d)), name, nameAr } });
  }

  const leaveTypes = {
    annual: await db.leaveType.create({ data: { companyId: cid, code: 'ANNUAL', name: 'Annual leave', nameAr: 'إجازة سنوية', color: '#2563eb', annualEntitlement: 30, accrualMethod: 'MONTHLY', maxCarryForward: 10, minNoticeDays: 0 } }),
    sick: await db.leaveType.create({ data: { companyId: cid, code: 'SICK', name: 'Sick leave', nameAr: 'إجازة مرضية', color: '#dc2626', annualEntitlement: 15, accrualMethod: 'ANNUAL', prorateFirstYear: false, minServiceMonths: 3 } }),
    emergency: await db.leaveType.create({ data: { companyId: cid, code: 'EMERGENCY', name: 'Emergency leave', nameAr: 'إجازة طارئة', color: '#f59e0b', annualEntitlement: 3, accrualMethod: 'ANNUAL', prorateFirstYear: false, maxConsecutiveDays: 3 } }),
    unpaid: await db.leaveType.create({ data: { companyId: cid, code: 'UNPAID', name: 'Unpaid leave', nameAr: 'إجازة بدون راتب', color: '#64748b', isPaid: false, accrualMethod: 'NONE', annualEntitlement: 0, minNoticeDays: 3 } }),
    maternity: await db.leaveType.create({ data: { companyId: cid, code: 'MATERNITY', name: 'Maternity leave', nameAr: 'إجازة أمومة', color: '#db2777', annualEntitlement: 60, accrualMethod: 'ANNUAL', prorateFirstYear: false, genderRestriction: 'FEMALE', countWeekendsAndHolidays: true, allowHalfDay: false, requiresAttachment: true } }),
  };

  // ── Pay components (example configuration — adjust to your own policy and local law) ──
  const comp = async (data: Omit<Parameters<typeof db.payComponent.create>[0]['data'], 'companyId' | 'company'>) => db.payComponent.create({ data: { ...data, companyId: cid } as never });
  const housing = await comp({ code: 'HOUSING', name: 'Housing allowance', nameAr: 'بدل سكن', type: 'EARNING', calcType: 'FIXED', pensionable: true, sortOrder: 10 });
  const transport = await comp({ code: 'TRANSPORT', name: 'Transportation allowance', nameAr: 'بدل مواصلات', type: 'EARNING', calcType: 'FIXED', sortOrder: 20 });
  const phone = await comp({ code: 'PHONE', name: 'Phone allowance', nameAr: 'بدل هاتف', type: 'EARNING', calcType: 'FIXED', sortOrder: 30 });
  await comp({ code: 'COLA', name: 'Cost of living allowance', nameAr: 'بدل غلاء معيشة', type: 'EARNING', calcType: 'PERCENT_OF_BASIC', defaultValue: 5, appliesToAll: true, pensionable: true, eligibility: { categoryCodes: ['NATIONAL'] }, sortOrder: 40 });
  // Pension (GPSSA/ADPF) is calculated by the statutory engine from each employee's scheme and Payroll → Calculation rules.
  await comp({ code: 'INSURANCE_ER', name: 'Medical insurance (employer)', nameAr: 'التأمين الطبي', type: 'EMPLOYER_CONTRIBUTION', calcType: 'FIXED', defaultValue: 450, appliesToAll: true, sortOrder: 120 });
  await comp({ code: 'INCOME_TAX', name: 'Income tax (example, inactive)', nameAr: 'ضريبة الدخل', type: 'DEDUCTION', calcType: 'BRACKET', bracketBase: 'TAXABLE', brackets: [{ upTo: 10000, rate: 0 }, { upTo: 30000, rate: 5 }, { upTo: null, rate: 10 }], appliesToAll: true, isActive: false, sortOrder: 90 });
  const loan = await comp({ code: 'LOAN', name: 'Salary advance repayment', nameAr: 'سداد سلفة', type: 'DEDUCTION', calcType: 'FIXED', isRecurring: true, sortOrder: 150 });

  // ── Workflows ──
  const wf = (requestType: string, name: string, steps: object[], extra: object = {}) =>
    db.workflowDefinition.create({ data: { companyId: cid, requestType, name, ...extra, steps: { create: steps.map((s, i) => ({ order: i + 1, ...s })) } as never } });
  await wf('LEAVE', 'Leave approval', [
    { name: 'Line manager', approverType: 'DIRECT_MANAGER', escalateAfterHours: 48, escalateToType: 'DEPARTMENT_MANAGER' },
    { name: 'HR review (over 5 days)', approverType: 'ROLE', roleCode: 'HR_MANAGER', minAmount: 5.5 },
  ]);
  await wf('ATTENDANCE_CORRECTION', 'Attendance correction', [{ name: 'Line manager', approverType: 'DIRECT_MANAGER' }, { name: 'HR', approverType: 'ROLE', roleCode: 'HR_MANAGER' }]);
  await wf('OVERTIME', 'Overtime approval', [{ name: 'Line manager', approverType: 'DIRECT_MANAGER', escalateAfterHours: 24, escalateToType: 'DEPARTMENT_MANAGER' }]);
  await wf('SALARY_CHANGE', 'Salary change', [{ name: 'HR Manager', approverType: 'ROLE', roleCode: 'HR_MANAGER' }, { name: 'Finance', approverType: 'ROLE', roleCode: 'FINANCE_OFFICER', minAmount: 2000 }]);
  await wf('PAYROLL', 'Payroll approval', [{ name: 'Finance Officer', approverType: 'ROLE', roleCode: 'FINANCE_OFFICER' }]);

  // ── Employees ──
  const adminActor = (await loadAuthUser(adminUser.id, 'seed'))!;
  // [position, manager index, branch, shift, basic, housing, transport, roles]
  const plan: [string, number | null, string, 'DAY' | 'WH', number, number, number, string[]][] = [
    ['CEO', null, 'DXB', 'DAY', 52000, 20000, 3000, []],
    ['HRM', 0, 'DXB', 'DAY', 26000, 9000, 1500, ['HR_MANAGER', 'DEPARTMENT_MANAGER']],
    ['FINM', 0, 'DXB', 'DAY', 28000, 9500, 1500, ['FINANCE_OFFICER', 'DEPARTMENT_MANAGER']],
    ['ITM', 0, 'DXB', 'DAY', 27000, 9000, 1500, ['DEPARTMENT_MANAGER']],
    ['SALM', 0, 'AUH', 'DAY', 25000, 8500, 2000, ['DEPARTMENT_MANAGER', 'BRANCH_MANAGER']],
    ['OPSM', 0, 'SHJ', 'WH', 24000, 8000, 2000, ['DEPARTMENT_MANAGER', 'BRANCH_MANAGER']],
    ['CSM', 0, 'DXB', 'DAY', 16000, 6000, 1200, ['DEPARTMENT_MANAGER']],
    ['HRS', 1, 'DXB', 'DAY', 11000, 4000, 800, ['HR_ADMIN']], ['HRS', 1, 'DXB', 'DAY', 10000, 3800, 800, []], ['REC', 1, 'DXB', 'DAY', 10500, 3800, 800, ['RECRUITMENT_OFFICER']],
    ['ACC', 2, 'DXB', 'DAY', 10000, 3800, 800, []], ['ACC', 2, 'DXB', 'DAY', 9500, 3500, 800, ['AUDITOR']], ['PAYO', 2, 'DXB', 'DAY', 11000, 4000, 800, ['PAYROLL_OFFICER']],
    ['DEV', 3, 'DXB', 'DAY', 19000, 6500, 1000, []], ['DEV', 3, 'DXB', 'DAY', 18000, 6000, 1000, []], ['DEV', 3, 'DXB', 'DAY', 17500, 6000, 1000, []], ['DEV', 3, 'DXB', 'DAY', 16000, 5500, 1000, []],
    ['SUP', 3, 'DXB', 'DAY', 6500, 2500, 600, []], ['SUP', 3, 'DXB', 'DAY', 6000, 2500, 600, []],
    ['SALE', 4, 'AUH', 'DAY', 9000, 3500, 1500, []], ['SALE', 4, 'AUH', 'DAY', 8800, 3500, 1500, []], ['SALE', 4, 'AUH', 'DAY', 8500, 3200, 1500, []], ['SALE', 4, 'AUH', 'DAY', 8500, 3200, 1500, []],
    ['SALE', 4, 'AUH', 'DAY', 8200, 3000, 1500, []], ['SALE', 4, 'DXB', 'DAY', 9500, 3500, 1500, []],
    ['WH', 5, 'SHJ', 'WH', 8000, 3000, 800, []], ['WH', 5, 'SHJ', 'WH', 7800, 3000, 800, []],
    ['DRV', 25, 'SHJ', 'WH', 4500, 1500, 500, []], ['DRV', 25, 'SHJ', 'WH', 4500, 1500, 500, []], ['DRV', 25, 'SHJ', 'WH', 4300, 1500, 500, []], ['DRV', 26, 'SHJ', 'WH', 4300, 1500, 500, []], ['DRV', 26, 'SHJ', 'WH', 4200, 1500, 500, []],
    ['CSA', 6, 'DXB', 'DAY', 5500, 2200, 500, []], ['CSA', 6, 'DXB', 'DAY', 5500, 2200, 500, []], ['CSA', 6, 'DXB', 'DAY', 5200, 2000, 500, []], ['CSA', 6, 'DXB', 'DAY', 5200, 2000, 500, []],
    ['CSA', 6, 'DXB', 'DAY', 5000, 2000, 500, []], ['SALE', 4, 'AUH', 'DAY', 8000, 3000, 1500, []], ['DEV', 3, 'DXB', 'DAY', 15000, 5000, 1000, []], ['HRS', 1, 'DXB', 'DAY', 9000, 3500, 800, []],
  ];

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const roleIds = Object.fromEntries((await db.role.findMany()).map((r) => [r.code, r.id]));
  const created: { id: string; userId: string; positionCode: string; gender: string; hireDate: Date; email: string }[] = [];
  const firstOfLastYear = new Date(Date.UTC(year - 1, 0, 1));
  for (let i = 0; i < plan.length; i++) {
    const [posCode, mgrIdx, br, shiftCode, basic, housingAmt, transportAmt, roles] = plan[i];
    const [first, last, firstAr, lastAr, gender, nat] = PEOPLE[i];
    const pos = positions[posCode];
    const isNational = nat === 'AE';
    // Leaders joined years ago; the rest spread over the last ~3 years, a few very recent.
    const hireDate = i < 7 ? new Date(Date.UTC(year - 6 + (i % 3), between(0, 11), between(1, 28))) : i >= plan.length - 3 ? addDays(today, -between(20, 70)) : addDays(firstOfLastYear, -between(0, 700));
    const email = `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '') + '@acme.example';
    const { employee } = await appPrisma.$transaction((tx) =>
      createEmployee(
        tx,
        cid,
        {
          firstName: first, lastName: last, firstNameAr: firstAr, lastNameAr: lastAr, email, phone: `+9715${between(0, 9)}${between(1000000, 9999999)}`, gender,
          dateOfBirth: isoDate(new Date(Date.UTC(between(1972, 2000), between(0, 11), between(1, 28)))), nationality: nat, maritalStatus: pick(['SINGLE', 'MARRIED']),
          nationalId: emiratesId(between(1970, 2000), between(1000000, 9999999)), address: pick(['Dubai Marina', 'Al Nahda', 'Khalifa City', 'Al Majaz', 'JLT', 'Mirdif']),
          emergencyContact: { name: `${pick(PEOPLE)[0]} ${last}`, relation: pick(['Spouse', 'Parent', 'Sibling']), phone: `+9715${between(10000000, 99999999)}` },
          branchId: branches[br].id, departmentId: pos.departmentId, positionId: pos.id, gradeId: pos.gradeId, categoryId: cats[isNational ? 'NATIONAL' : 'EXPAT'].id,
          employmentTypeId: types[i % 11 === 10 ? 'CONTRACT' : 'FULL_TIME'].id, costCenterId: null, managerId: mgrIdx === null ? null : created[mgrIdx].id,
          shiftId: shiftCode === 'WH' ? whShift.id : null, hireDate: isoDate(hireDate),
          contractStartDate: isoDate(hireDate), contractEndDate: i % 11 === 10 ? isoDate(addDays(today, between(20, 80))) : null,
          bankName: pick(['Emirates NBD', 'ADCB', 'FAB', 'Mashreq', 'Dubai Islamic Bank']), iban: `AE${between(10, 99)}0${between(10, 99)}${String(between(1e9, 9e9))}${String(between(1e6, 9e6))}`,
          // Abu Dhabi nationals contribute to ADPF; other UAE nationals default to GPSSA by hire date.
          ...(isNational && br === 'AUH' ? { pensionScheme: 'ADPF_OLD' as const } : {}),
          createUserAccount: false, roleCodes: [], confirmDuplicate: true,
        },
        adminActor,
      ),
    );
    const user = await db.user.create({
      data: {
        email, displayName: `${first} ${last}`, passwordHash, employeeId: employee.id,
        roles: { create: ['EMPLOYEE', ...roles].map((code) => ({ roleId: roleIds[code], companyId: cid })) },
      },
    });
    created.push({ id: employee.id, userId: user.id, positionCode: posCode, gender, hireDate: employee.hireDate, email });

    const items = [{ componentId: housing.id, amount: housingAmt }, { componentId: transport.id, amount: transportAmt }];
    if (basic >= 15000) items.push({ componentId: phone.id, amount: 500 });
    if (i % 9 === 4) items.push({ componentId: loan.id, amount: 750 });
    // Salary setup goes through the SALARY_CHANGE workflow; approve it as HR and Finance below.
    await proposeSalary({ employeeId: employee.id, effectiveFrom: isoDate(employee.hireDate), basicSalary: basic, currency: 'AED', items, reason: 'Initial salary' }, adminUser.id);
  }
  // Department and branch managers.
  const mgr = (code: string) => created.find((c) => c.positionCode === code)!.id;
  for (const [dept, pos] of [['EXEC', 'CEO'], ['HR', 'HRM'], ['FIN', 'FINM'], ['IT', 'ITM'], ['SALES', 'SALM'], ['OPS', 'OPSM'], ['CS', 'CSM']]) {
    await db.department.update({ where: { id: depts[dept].id }, data: { managerId: mgr(pos) } });
  }
  await db.branch.update({ where: { id: branches.DXB.id }, data: { managerId: mgr('CEO') } });
  await db.branch.update({ where: { id: branches.AUH.id }, data: { managerId: mgr('SALM') } });
  await db.branch.update({ where: { id: branches.SHJ.id }, data: { managerId: mgr('OPSM') } });

  // Approve all salary setups (HR manager first step, finance second when above the limit).
  await approveAllPending(db, 'SALARY_CHANGE');
  // A pending raise to show the workflow in action.
  await proposeSalary({ employeeId: created[13].id, effectiveFrom: isoDate(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1))), basicSalary: 21000, currency: 'AED', items: [{ componentId: housing.id, amount: 7000 }, { componentId: transport.id, amount: 1000 }, { componentId: phone.id, amount: 500 }], reason: 'Annual performance increment' }, created[3].userId);

  // ── Attendance: last ~45 days ──
  const start = addDays(today, -45);
  const policy = { minOvertimeMinutes: 30 };
  let records = 0;
  for (const e of created) {
    const cal = await employeeCalendar(e.id, start > e.hireDate ? start : e.hireDate, addDays(today, -1));
    for (const day of cal) {
      if (!day.isWorkingDay || !day.shift) continue;
      const roll = rand();
      if (roll < 0.025) {
        await db.attendanceRecord.create({ data: { employeeId: e.id, date: day.date, status: 'ABSENT', source: 'MANUAL', notes: 'No punches recorded', shiftId: day.shift.id } });
        records++;
        continue;
      }
      const [sh, sm] = day.shift.startTime.split(':').map(Number);
      const lateBias = roll < 0.12 ? between(16, 55) : between(-20, 12);
      const checkIn = new Date(zonedTimeToUtc(day.date, day.shift.startTime, TZ).getTime() + lateBias * 60_000);
      const workMinutes = 9 * 60 + (rand() < 0.15 ? between(policy.minOvertimeMinutes + 10, 150) : between(-25, 25));
      const checkOut = roll > 0.985 ? null : new Date(checkIn.getTime() + workMinutes * 60_000);
      void sh;
      void sm;
      await db.attendanceRecord.create({ data: { employeeId: e.id, date: day.date, checkIn, checkOut, source: pick(['WEB', 'DEVICE', 'DEVICE', 'MOBILE']), shiftId: day.shift.id } });
      await recalculateRecord(appPrisma, e.id, day.date);
      records++;
    }
  }

  // ── Leave ──
  const leaveSamples: [number, keyof typeof leaveTypes, number, number, boolean][] = [
    // [employee index, type, start offset from today, working days length, approve?]
    [8, 'annual', -30, 5, true], [14, 'annual', -20, 3, true], [20, 'sick', -12, 2, true], [33, 'annual', -9, 4, true], [27, 'unpaid', -16, 2, true],
    [15, 'annual', 0, 3, true], [22, 'sick', 0, 1, true], [10, 'annual', 7, 5, false], [17, 'annual', 14, 8, false], [35, 'emergency', 2, 1, false], [29, 'annual', 21, 10, false],
  ];
  for (const [idx, type, offset, len, approve] of leaveSamples) {
    const e = created[idx];
    const lt = leaveTypes[type];
    if (lt.genderRestriction && lt.genderRestriction !== e.gender) continue;
    let s = addDays(today, offset);
    while ([0, 6].includes(s.getUTCDay())) s = addDays(s, 1);
    let end = s;
    let n = 1;
    while (n < len) {
      end = addDays(end, 1);
      if (![0, 6].includes(end.getUTCDay())) n++;
    }
    try {
      // Past leave is entered by HR on behalf of the employee (pre-approved); upcoming leave goes through approval.
      const backdated = offset < 0 && approve;
      // Remove generated attendance on those days so leave shows correctly.
      if (backdated) await db.attendanceRecord.deleteMany({ where: { employeeId: e.id, date: { gte: s, lte: end } } });
      const req = await createLeaveRequest(
        { employeeId: e.id, leaveTypeId: lt.id, startDate: isoDate(s), endDate: isoDate(end), reason: pick(['Family visit', 'Personal matters', 'Travel', 'Medical appointment']) },
        backdated ? created[1].userId : e.userId,
        { autoApprove: backdated },
      );
      if (approve && !backdated) await approveChain(db, 'LEAVE', req.id);
    } catch (err) {
      console.warn(`  leave sample skipped: ${(err as Error).message}`);
    }
  }

  // A pending attendance correction and overtime request.
  const { requestCorrection, requestOvertime } = await import('../src/modules/attendance/service');
  const yesterdayWork = (() => {
    let d = addDays(today, -1);
    while ([0, 6].includes(d.getUTCDay())) d = addDays(d, -1);
    return d;
  })();
  try {
    await requestCorrection({ employeeId: created[18].id, date: isoDate(yesterdayWork), checkIn: zonedTimeToUtc(yesterdayWork, '08:58', TZ).toISOString(), reason: 'Card reader was not working in the morning' }, created[18].userId);
    await requestOvertime({ employeeId: created[16].id, date: isoDate(today), minutes: 120, reason: 'Production release support' }, created[16].userId);
  } catch (err) {
    console.warn(`  request sample skipped: ${(err as Error).message}`);
  }

  // ── Payroll: last month approved and paid ──
  const lastMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const run = await createRun({ companyId: cid, year: lastMonth.getUTCFullYear(), month: lastMonth.getUTCMonth() + 1 }, created[12].userId);
  await calculateRun(run.id, created[12].userId);
  await submitRun(run.id, created[12].userId, 'Monthly payroll');
  await approveChain(db, 'PAYROLL', `${run.id}#0`);
  await markPaid(run.id, created[2].userId, { reference: 'WPS-DEMO-001' });

  await db.announcement.create({
    data: { companyId: cid, title: 'Welcome to the new HR portal', body: 'You can now check in, request leave, view payslips and track approvals in one place. Contact HR with any questions.', publishedAt: new Date(), createdById: adminUser.id },
  });

  console.log(`✔ Demo company "Acme Trading LLC": ${created.length} employees, ${records} attendance records, payroll ${lastMonth.toISOString().slice(0, 7)} paid`);
  console.log(`  All demo users sign in with password ${DEMO_PASSWORD}. Examples:`);
  const show = (idx: number, label: string) => console.log(`   ${label.padEnd(22)} ${created[idx].email}`);
  show(1, 'HR Manager');
  show(7, 'HR Administrator');
  show(12, 'Payroll Officer');
  show(2, 'Finance Officer');
  show(3, 'Department Manager (IT)');
  show(4, 'Branch Manager (AUH)');
  show(11, 'Auditor');
  show(13, 'Employee');
}

/** Approves every open task of a request type by whoever holds the task, until none remain. */
async function approveAllPending(db: PrismaClient, requestType: string) {
  for (let guard = 0; guard < 10; guard++) {
    const pending = await db.approvalRequest.findMany({ where: { requestType, status: 'PENDING' }, include: { tasks: { where: { status: 'OPEN' } } } });
    if (!pending.length) return;
    for (const p of pending) {
      const task = p.tasks.find((t) => t.stepOrder === p.currentStep);
      if (task) await decide(p.id, task.assigneeId, 'APPROVED', 'Approved during setup');
    }
  }
}

async function approveChain(db: PrismaClient, requestType: string, entityId: string) {
  for (let guard = 0; guard < 10; guard++) {
    const p = await db.approvalRequest.findUnique({ where: { requestType_entityId: { requestType, entityId } }, include: { tasks: { where: { status: 'OPEN' } } } });
    if (!p || p.status !== 'PENDING') return;
    const task = p.tasks.find((t) => t.stepOrder === p.currentStep);
    if (!task) return;
    await decide(p.id, task.assigneeId, 'APPROVED', 'Looks good');
  }
}
