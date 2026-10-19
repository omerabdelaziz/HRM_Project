import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import type { Payslip, PayslipLine, PayrollRun, Company } from '@prisma/client';
import { presentBank } from './service';
import { mask } from '../../lib/crypto';
import { csvCell } from '../../lib/csv';
import { BRAND, drawLogo, drawLogoMark } from '../../lib/brand';

type SlipWithLines = Payslip & { lines: PayslipLine[] };

function money(v: { toString(): string } | number, currency: string) {
  const n = Number(v.toString());
  return `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Renders a payslip PDF. Arabic labels are omitted because the built-in PDF fonts cannot shape Arabic script. */
export function payslipPdf(slip: SlipWithLines, run: PayrollRun, company: Company): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Payslip ${run.year}-${run.month}`, Author: company.name } });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const snap = slip.snapshot as Record<string, string | null>;
    const bank = presentBank(slip.snapshot);
    const left = 48;
    const width = doc.page.width - 96;

    drawLogo(doc, left + width - 118, 46, 22);
    doc.fillColor(BRAND.navy).fontSize(18).font('Helvetica-Bold').text(company.legalName || company.name, left, 48, { width: width - 140 });
    doc.fontSize(9).font('Helvetica').fillColor(BRAND.muted).text([company.address, company.phone, company.email].filter(Boolean).join('  ·  '));
    doc.moveDown(0.5);
    doc.fontSize(13).fillColor(BRAND.royal).font('Helvetica-Bold').text(`Payslip — ${MONTHS[run.month - 1]} ${run.year}`, left);
    doc.moveTo(left, doc.y + 6).lineTo(left + width, doc.y + 6).lineWidth(2).strokeColor(BRAND.navy).stroke().lineWidth(1);
    doc.moveDown(1);

    const info: [string, string][] = [
      ['Employee', `${snap.name} (${snap.employeeNo})`],
      ['Department', snap.department ?? '—'],
      ['Position', snap.position ?? '—'],
      ['Branch', snap.branch ?? '—'],
      ['Pay period', `${run.periodStart.toISOString().slice(0, 10)} to ${run.periodEnd.toISOString().slice(0, 10)}`],
      ['Payable days', `${slip.payableDays} of ${slip.periodDays}`],
      ['Bank', bank.bankName ?? '—'],
      ['Account', mask(bank.iban ?? bank.bankAccount) ?? '—'],
    ];
    const colW = width / 2;
    const startY = doc.y;
    info.forEach(([k, v], i) => {
      const x = left + (i % 2) * colW;
      const y = startY + Math.floor(i / 2) * 18;
      doc.fontSize(8).fillColor('#64748b').font('Helvetica').text(k.toUpperCase(), x, y);
      doc.fontSize(10).fillColor('#0f172a').text(v, x + 85, y - 1, { width: colW - 90 });
    });
    doc.y = startY + Math.ceil(info.length / 2) * 18 + 14;

    const table = (title: string, rows: PayslipLine[], total: string) => {
      const y0 = doc.y;
      doc.rect(left, y0, width, 20).fill('#EEF2F8');
      doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(10).text(title, left + 8, y0 + 6);
      doc.text('Amount', left, y0 + 6, { width: width - 8, align: 'right' });
      let y = y0 + 26;
      doc.font('Helvetica').fontSize(10);
      for (const l of rows) {
        const qty = l.quantity ? `  (${l.quantity}${l.source === 'OVERTIME' || l.source === 'LATE' ? ' h' : ' d'})` : '';
        doc.fillColor('#0f172a').text(l.name + qty, left + 8, y, { width: width * 0.7 });
        doc.text(money(l.amount, slip.currency), left, y, { width: width - 8, align: 'right' });
        y += 16;
      }
      doc.moveTo(left, y + 2).lineTo(left + width, y + 2).strokeColor('#e2e8f0').stroke();
      doc.font('Helvetica-Bold').text(`Total ${title.toLowerCase()}`, left + 8, y + 8);
      doc.text(total, left, y + 8, { width: width - 8, align: 'right' });
      doc.y = y + 30;
    };

    table('Earnings', slip.lines.filter((l) => l.type === 'EARNING'), money(slip.grossEarnings, slip.currency));
    table('Deductions', slip.lines.filter((l) => l.type === 'DEDUCTION'), money(slip.totalDeductions, slip.currency));

    const y = doc.y;
    doc.roundedRect(left, y, width, 34, 6).fill(BRAND.navy);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(12).text('NET PAY', left + 12, y + 11);
    doc.text(money(slip.netPay, slip.currency), left, y + 11, { width: width - 12, align: 'right' });
    doc.y = y + 50;

    const employer = slip.lines.filter((l) => l.type === 'EMPLOYER_CONTRIBUTION');
    if (employer.length) {
      doc.fillColor('#64748b').font('Helvetica').fontSize(8).text(
        `Employer contributions (not deducted from pay): ${employer.map((l) => `${l.name} ${money(l.amount, slip.currency)}`).join(', ')}`,
        left,
      );
    }
    const infoLines = slip.lines.filter((l) => l.type === 'INFORMATION');
    if (infoLines.length) {
      doc.fillColor('#64748b').font('Helvetica').fontSize(8).text(
        `For information (not included in totals): ${infoLines.map((l) => `${l.name} ${money(l.amount, slip.currency)}`).join(', ')}`,
        left,
      );
    }
    drawLogoMark(doc, left, doc.page.height - 74, 14);
    doc.fillColor(BRAND.muted).fontSize(8).text(`Generated by Aziz HRM on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. This document is computer generated and does not require a signature.`, left + 20, doc.page.height - 71, { width: width - 20 });
    doc.end();
  });
}

/** Generic bank salary-transfer CSV (one row per paid employee). */
export function bankFileCsv(run: PayrollRun, company: Company, slips: Payslip[]) {
  const header = ['EmployeeNo', 'EmployeeName', 'BankName', 'IBAN', 'AccountNumber', 'Amount', 'Currency', 'Reference'];
  const ref = `SAL-${company.code}-${run.year}${String(run.month).padStart(2, '0')}`;
  const rows = slips
    .filter((s) => Number(s.netPay) > 0 && s.paymentStatus !== 'ON_HOLD')
    .map((s) => {
      const snap = s.snapshot as Record<string, string>;
      const bank = presentBank(s.snapshot);
      return [snap.employeeNo, snap.name, bank.bankName, bank.iban, bank.bankAccount, Number(s.netPay).toFixed(2), s.currency, ref];
    });
  const missing = rows.filter((r) => !r[3] && !r[4]).map((r) => r[0]);
  const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  return { csv, missing, count: rows.length };
}

export async function payrollRegisterXlsx(run: PayrollRun, slips: SlipWithLines[]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(`Payroll ${run.year}-${String(run.month).padStart(2, '0')}`);
  const codes = new Map<string, { name: string; type: string }>();
  for (const s of slips) for (const l of s.lines) if (!codes.has(l.componentCode)) codes.set(l.componentCode, { name: l.name, type: l.type });
  const typeOrder = ['EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION', 'INFORMATION'];
  const ordered = [...codes.entries()].sort((a, b) => typeOrder.indexOf(a[1].type) - typeOrder.indexOf(b[1].type));
  ws.columns = [
    { header: 'Employee No', key: 'no', width: 14 },
    { header: 'Name', key: 'name', width: 26 },
    { header: 'Department', key: 'dept', width: 20 },
    { header: 'Branch', key: 'branch', width: 16 },
    { header: 'Currency', key: 'cur', width: 9 },
    { header: 'Payable days', key: 'days', width: 12 },
    ...ordered.map(([code, c]) => ({ header: `${c.name}${c.type === 'DEDUCTION' ? ' (−)' : c.type === 'EMPLOYER_CONTRIBUTION' ? ' (employer)' : c.type === 'INFORMATION' ? ' (info)' : ''}`, key: `c_${code}`, width: 16 })),
    { header: 'Gross', key: 'gross', width: 14 },
    { header: 'Deductions', key: 'ded', width: 14 },
    { header: 'Net pay', key: 'net', width: 14 },
    { header: 'Employer cost', key: 'cost', width: 14 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1, xSplit: 2 }];
  for (const s of slips) {
    const snap = s.snapshot as Record<string, string>;
    const row: Record<string, unknown> = {
      no: snap.employeeNo, name: snap.name, dept: snap.department, branch: snap.branch, cur: s.currency, days: Number(s.payableDays),
      gross: Number(s.grossEarnings), ded: Number(s.totalDeductions), net: Number(s.netPay), cost: Number(s.employerCost),
    };
    for (const l of s.lines) row[`c_${l.componentCode}`] = Number(row[`c_${l.componentCode}`] ?? 0) + Number(l.amount);
    ws.addRow(row);
  }
  const totalRow = ws.addRow({ name: 'TOTAL' });
  totalRow.font = { bold: true };
  ws.columns.forEach((col, i) => {
    if (i < 6 || !col.letter) return;
    totalRow.getCell(i + 1).value = { formula: `SUM(${col.letter}2:${col.letter}${slips.length + 1})` };
  });
  ws.eachRow((row, n) => {
    if (n > 1) row.eachCell((cell, col) => col > 6 && (cell.numFmt = '#,##0.00'));
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
