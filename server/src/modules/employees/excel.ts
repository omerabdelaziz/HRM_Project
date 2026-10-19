import ExcelJS from 'exceljs';
import { prisma, Prisma } from '../../lib/prisma';
import { AuthUser } from '../../auth/context';
import { createEmployee, createEmployeeSchema, findDuplicates } from './service';
import { badRequest } from '../../lib/errors';
import { decrypt } from '../../lib/crypto';
import { hasPermission } from '../../auth/context';

export const IMPORT_COLUMNS = [
  { key: 'employeeNo', header: 'Employee No', note: 'Optional. Leave blank to auto-generate.' },
  { key: 'firstName', header: 'First Name*' },
  { key: 'lastName', header: 'Last Name*' },
  { key: 'firstNameAr', header: 'First Name (Arabic)' },
  { key: 'lastNameAr', header: 'Last Name (Arabic)' },
  { key: 'email', header: 'Work Email*' },
  { key: 'phone', header: 'Phone' },
  { key: 'gender', header: 'Gender', note: 'MALE or FEMALE' },
  { key: 'dateOfBirth', header: 'Date of Birth', note: 'YYYY-MM-DD' },
  { key: 'nationality', header: 'Nationality', note: 'ISO country code, e.g. AE, IN, JO' },
  { key: 'nationalId', header: 'National ID' },
  { key: 'hireDate', header: 'Hire Date*', note: 'YYYY-MM-DD' },
  { key: 'branchCode', header: 'Branch Code*' },
  { key: 'departmentCode', header: 'Department Code*' },
  { key: 'positionCode', header: 'Position Code*' },
  { key: 'gradeCode', header: 'Grade Code' },
  { key: 'categoryCode', header: 'Category Code' },
  { key: 'employmentTypeCode', header: 'Employment Type Code' },
  { key: 'costCenterCode', header: 'Cost Center Code' },
  { key: 'managerEmployeeNo', header: 'Manager Employee No', note: 'May refer to a row earlier in this file' },
  { key: 'contractEndDate', header: 'Contract End Date', note: 'YYYY-MM-DD' },
  { key: 'bankName', header: 'Bank Name' },
  { key: 'bankAccount', header: 'Bank Account' },
  { key: 'iban', header: 'IBAN' },
] as const;

export async function importTemplate() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Employees');
  ws.columns = IMPORT_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: Math.max(14, c.header.length + 4) }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  IMPORT_COLUMNS.forEach((c, i) => {
    if ('note' in c) ws.getCell(1, i + 1).note = c.note;
  });
  ws.addRow({ firstName: 'Sara', lastName: 'Ahmed', email: 'sara.ahmed@example.com', gender: 'FEMALE', hireDate: '2025-01-15', departmentCode: 'HR' });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('text' in v) return String(v.text);
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue);
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
  }
  return String(v).trim();
}

export interface ImportRowResult {
  row: number;
  ok: boolean;
  errors: string[];
  employeeNo?: string;
  name?: string;
}

/**
 * Validates every row first; nothing is written unless all rows are valid and dryRun is false.
 * Then creates all employees in one transaction.
 */
export async function importEmployees(file: Buffer, companyId: string, actor: AuthUser, dryRun: boolean) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(file);
  } catch {
    throw badRequest('The file is not a valid .xlsx workbook');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw badRequest('The workbook has no sheets');
  const headerMap = new Map<number, string>();
  ws.getRow(1).eachCell((cell, col) => {
    const text = cellText(cell.value).toLowerCase();
    const def = IMPORT_COLUMNS.find((c) => c.header.toLowerCase() === text || c.header.replace('*', '').toLowerCase() === text || c.key.toLowerCase() === text);
    if (def) headerMap.set(col, def.key);
  });
  if (![...headerMap.values()].includes('email')) throw badRequest('Missing required column "Work Email*". Download the template for the expected format.');

  const raw: { row: number; data: Record<string, string> }[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const data: Record<string, string> = {};
    headerMap.forEach((key, col) => (data[key] = cellText(row.getCell(col).value)));
    if (Object.values(data).some((v) => v)) raw.push({ row: n, data });
  });
  if (!raw.length) throw badRequest('The file contains no data rows');
  if (raw.length > 5000) throw badRequest('Import at most 5,000 rows per file');

  const [branches, departments, positions, grades, categories, types, costCenters] = await Promise.all([
    prisma.branch.findMany({ where: { companyId }, select: { id: true, code: true } }),
    prisma.department.findMany({ where: { companyId }, select: { id: true, code: true } }),
    prisma.position.findMany({ where: { companyId }, select: { id: true, code: true } }),
    prisma.jobGrade.findMany({ where: { companyId }, select: { id: true, code: true } }),
    prisma.employeeCategory.findMany({ where: { companyId }, select: { id: true, code: true } }),
    prisma.employmentType.findMany({ where: { companyId }, select: { id: true, code: true } }),
    prisma.costCenter.findMany({ where: { companyId }, select: { id: true, code: true } }),
  ]);
  const lookup = (list: { id: string; code: string }[], code: string, label: string, errors: string[]) => {
    if (!code) return null;
    const hit = list.find((x) => x.code.toLowerCase() === code.toLowerCase());
    if (!hit) errors.push(`Unknown ${label} code "${code}"`);
    return hit?.id ?? null;
  };

  const fileEmails = new Map<string, number>();
  const fileNos = new Map<string, number>();
  const prepared: { row: number; input: ReturnType<typeof createEmployeeSchema.parse>; employeeNo?: string; managerNo?: string }[] = [];
  const results: ImportRowResult[] = [];

  for (const { row, data } of raw) {
    const errors: string[] = [];
    const candidate = {
      firstName: data.firstName,
      lastName: data.lastName,
      firstNameAr: data.firstNameAr || null,
      lastNameAr: data.lastNameAr || null,
      email: data.email,
      phone: data.phone || null,
      gender: data.gender ? data.gender.toUpperCase() : null,
      dateOfBirth: data.dateOfBirth || null,
      nationality: data.nationality || null,
      nationalId: data.nationalId || null,
      hireDate: data.hireDate,
      branchId: lookup(branches, data.branchCode, 'branch', errors),
      departmentId: lookup(departments, data.departmentCode, 'department', errors),
      positionId: lookup(positions, data.positionCode, 'position', errors),
      gradeId: lookup(grades, data.gradeCode, 'grade', errors),
      categoryId: lookup(categories, data.categoryCode, 'category', errors),
      employmentTypeId: lookup(types, data.employmentTypeCode, 'employment type', errors),
      costCenterId: lookup(costCenters, data.costCenterCode, 'cost center', errors),
      contractEndDate: data.contractEndDate || null,
      bankName: data.bankName || null,
      bankAccount: data.bankAccount || null,
      iban: data.iban || null,
      createUserAccount: false,
    };
    const parsed = createEmployeeSchema.safeParse(candidate);
    if (!parsed.success) errors.push(...parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
    const email = data.email?.toLowerCase();
    if (email) {
      if (fileEmails.has(email)) errors.push(`Email duplicates row ${fileEmails.get(email)}`);
      else fileEmails.set(email, row);
    }
    if (data.employeeNo) {
      if (fileNos.has(data.employeeNo)) errors.push(`Employee No duplicates row ${fileNos.get(data.employeeNo)}`);
      else fileNos.set(data.employeeNo, row);
      if (await prisma.employee.findUnique({ where: { employeeNo: data.employeeNo }, select: { id: true } })) errors.push(`Employee No ${data.employeeNo} already exists`);
    }
    if (parsed.success) {
      const dups = await findDuplicates(prisma, companyId, parsed.data);
      for (const d of dups) errors.push(`Possible duplicate of ${d.employeeNo} (${d.name}) by ${d.reasons.join(', ')}`);
      prepared.push({ row, input: parsed.data, employeeNo: data.employeeNo || undefined, managerNo: data.managerEmployeeNo || undefined });
    }
    results.push({ row, ok: errors.length === 0, errors, name: `${data.firstName ?? ''} ${data.lastName ?? ''}`.trim() });
  }

  // Managers must exist in the database or appear in this file.
  for (const p of prepared) {
    if (!p.managerNo) continue;
    const inFile = fileNos.has(p.managerNo);
    const inDb = await prisma.employee.findFirst({ where: { employeeNo: p.managerNo, companyId, deletedAt: null }, select: { id: true } });
    if (!inFile && !inDb) {
      const res = results.find((r) => r.row === p.row)!;
      res.ok = false;
      res.errors.push(`Manager employee no "${p.managerNo}" not found`);
    }
  }

  const valid = results.every((r) => r.ok);
  const summary = { total: results.length, valid: results.filter((r) => r.ok).length, invalid: results.filter((r) => !r.ok).length };
  if (!valid || dryRun) {
    return { committed: false, dryRun, summary, rows: results };
  }

  const job = await prisma.backgroundJob.create({ data: { type: 'EMPLOYEE_IMPORT', status: 'RUNNING', createdById: actor.id, startedAt: new Date(), input: { rows: results.length } } });
  try {
    await prisma.$transaction(
      async (tx) => {
        const created = new Map<string, string>(); // employeeNo -> id
        for (const p of prepared) {
          const { employee } = await createEmployee(tx, companyId, { ...p.input, confirmDuplicate: true }, actor, { employeeNo: p.employeeNo });
          created.set(employee.employeeNo, employee.id);
          const res = results.find((r) => r.row === p.row)!;
          res.employeeNo = employee.employeeNo;
        }
        for (const p of prepared) {
          if (!p.managerNo) continue;
          const managerId = created.get(p.managerNo) ?? (await tx.employee.findFirst({ where: { employeeNo: p.managerNo, companyId }, select: { id: true } }))?.id;
          const selfNo = results.find((r) => r.row === p.row)!.employeeNo!;
          await tx.employee.update({ where: { employeeNo: selfNo }, data: { managerId } });
        }
      },
      { timeout: 600_000, maxWait: 30_000 },
    );
    await prisma.backgroundJob.update({ where: { id: job.id }, data: { status: 'DONE', progress: 100, finishedAt: new Date(), result: summary as Prisma.InputJsonValue } });
  } catch (e) {
    await prisma.backgroundJob.update({ where: { id: job.id }, data: { status: 'FAILED', error: (e as Error).message, finishedAt: new Date() } });
    throw e;
  }
  return { committed: true, dryRun, summary, rows: results, jobId: job.id };
}

export async function exportEmployees(where: Prisma.EmployeeWhereInput, user: AuthUser) {
  const sensitive = hasPermission(user, 'employee.sensitive.read');
  const rows = await prisma.employee.findMany({
    where,
    include: {
      branch: { select: { code: true, name: true } },
      department: { select: { code: true, name: true } },
      position: { select: { code: true, title: true } },
      grade: { select: { code: true } },
      category: { select: { code: true } },
      employmentType: { select: { code: true } },
      costCenter: { select: { code: true } },
      manager: { select: { employeeNo: true } },
    },
    orderBy: { employeeNo: 'asc' },
  });
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Aziz HRM';
  const ws = wb.addWorksheet('Employees');
  const cols = [
    ...IMPORT_COLUMNS.filter((c) => sensitive || !['nationalId', 'bankAccount', 'iban'].includes(c.key)).map((c) => ({ header: c.header.replace('*', ''), key: c.key, width: 18 })),
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Department', key: 'departmentName', width: 22 },
    { header: 'Position', key: 'positionTitle', width: 22 },
  ];
  ws.columns = cols;
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  const d = (v: Date | null) => (v ? v.toISOString().slice(0, 10) : '');
  for (const e of rows) {
    ws.addRow({
      employeeNo: e.employeeNo, firstName: e.firstName, lastName: e.lastName, firstNameAr: e.firstNameAr, lastNameAr: e.lastNameAr,
      email: e.email, phone: e.phone, gender: e.gender, dateOfBirth: d(e.dateOfBirth), nationality: e.nationality,
      nationalId: sensitive ? decrypt(e.nationalIdEnc) : undefined, hireDate: d(e.hireDate),
      branchCode: e.branch?.code, departmentCode: e.department?.code, positionCode: e.position?.code, gradeCode: e.grade?.code,
      categoryCode: e.category?.code, employmentTypeCode: e.employmentType?.code, costCenterCode: e.costCenter?.code,
      managerEmployeeNo: e.manager?.employeeNo, contractEndDate: d(e.contractEndDate), bankName: e.bankName,
      bankAccount: sensitive ? decrypt(e.bankAccountEnc) : undefined, iban: sensitive ? decrypt(e.ibanEnc) : undefined,
      status: e.status, departmentName: e.department?.name, positionTitle: e.position?.title,
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
