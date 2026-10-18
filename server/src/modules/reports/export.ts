import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { Column, ReportResult } from './definitions';
import { BRAND, drawLogo } from '../../lib/brand';

function display(v: unknown, c: Column) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (c.type === 'percent') return `${(v * 100).toFixed(1)}%`;
    if (c.type === 'money') return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (c.type === 'hours') return v.toFixed(2);
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }
  return String(v);
}

export async function toXlsx(report: ReportResult) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Aziz HRM';
  const ws = wb.addWorksheet(report.title.slice(0, 31).replace(/[\\/*?:[\]]/g, '-'));
  ws.columns = report.columns.map((c) => ({ header: c.label, key: c.key, width: Math.max(12, c.label.length + 4) }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const row of report.rows) ws.addRow(row);
  report.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    if (c.type === 'percent') col.numFmt = '0.0%';
    else if (c.type === 'money') col.numFmt = '#,##0.00';
    else if (c.type === 'hours') col.numFmt = '0.00';
  });
  if (report.rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: report.columns.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function toCsv(report: ReportResult) {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [report.columns.map((c) => esc(c.label)).join(',')];
  for (const row of report.rows) {
    lines.push(report.columns.map((c) => {
      const v = row[c.key];
      return esc(typeof v === 'number' && c.type !== 'percent' ? String(Math.round(v * 100) / 100) : display(v, c));
    }).join(','));
  }
  return Buffer.from(`﻿${lines.join('\r\n')}`, 'utf8');
}

export function toPdf(report: ReportResult, companyName: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const landscape = report.columns.length > 6;
    const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 36 });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const width = doc.page.width - 72;
    const colW = width / report.columns.length;
    drawLogo(doc, 36 + width - 104, 32, 20);
    doc.font('Helvetica-Bold').fontSize(14).fillColor(BRAND.navy).text(report.title, 36, 36, { width: width - 120 });
    doc.font('Helvetica').fontSize(8).fillColor(BRAND.muted).text(`${companyName} · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · ${report.rows.length} rows`);
    doc.moveDown(0.8);
    const header = () => {
      const y = doc.y;
      doc.rect(36, y - 2, width, 16).fill(BRAND.navy);
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(7);
      report.columns.forEach((c, i) => doc.text(c.label, 36 + i * colW + 3, y + 2, { width: colW - 6, ellipsis: true, lineBreak: false, align: c.type && c.type !== 'text' && c.type !== 'date' ? 'right' : 'left' }));
      doc.y = y + 18;
    };
    header();
    doc.font('Helvetica').fontSize(7);
    for (const row of report.rows) {
      if (doc.y > doc.page.height - 50) {
        doc.addPage();
        header();
        doc.font('Helvetica').fontSize(7);
      }
      const y = doc.y;
      report.columns.forEach((c, i) =>
        doc.fillColor('#0f172a').text(display(row[c.key], c), 36 + i * colW + 3, y, { width: colW - 6, ellipsis: true, lineBreak: false, align: c.type && c.type !== 'text' && c.type !== 'date' ? 'right' : 'left' }),
      );
      doc.y = y + 13;
      doc.moveTo(36, doc.y - 2).lineTo(36 + width, doc.y - 2).strokeColor('#f1f5f9').stroke();
    }
    doc.end();
  });
}

export const MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
  pdf: 'application/pdf',
} as const;
