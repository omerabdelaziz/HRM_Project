// Aziz HRM brand assets shared by PDFs and emails. Paths match client/src/components/Logo.tsx.
import type PDFKit from 'pdfkit';

export const BRAND = {
  name: 'Aziz HRM',
  navy: '#102A43',
  royal: '#2563EB',
  cyan: '#38BDF8',
  text: '#1E293B',
  muted: '#64748B',
  line: '#E2E8F0',
  soft: '#F5F7FB',
};

/** Draws the logo mark (64-unit artwork) at x,y scaled to `size` points. */
export function drawLogoMark(doc: PDFKit.PDFDocument, x: number, y: number, size = 28) {
  const s = size / 64;
  doc.save();
  doc.translate(x, y).scale(s);
  doc.roundedRect(0, 0, 64, 64, 15).fill(BRAND.navy);
  doc.path('M16 50 L28.6 17.5 C30 14 34 14 35.4 17.5 L48 50').lineWidth(6.5).lineCap('round').lineJoin('round').stroke('#FFFFFF');
  doc.circle(32, 29.5, 4.2).fill(BRAND.cyan);
  doc.path('M23.5 44 C24.4 38.6 27.9 36 32 36 C36.1 36 39.6 38.6 40.5 44 Z').fill(BRAND.cyan);
  doc.restore();
}

/** Logo mark + "Aziz HRM" wordmark; returns the width used. */
export function drawLogo(doc: PDFKit.PDFDocument, x: number, y: number, size = 24) {
  drawLogoMark(doc, x, y, size);
  const fs = size * 0.56;
  doc.font('Helvetica-Bold').fontSize(fs).fillColor(BRAND.navy).text('Aziz ', x + size + 7, y + (size - fs) / 2 + 1, { continued: true, lineBreak: false }).fillColor(BRAND.royal).text('HRM', { lineBreak: false });
  return size + 7 + doc.widthOfString('Aziz HRM');
}

/** Branded HTML email body around plain text content. */
export function emailHtml(title: string, body: string, actionUrl?: string) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return `<!doctype html><html><body style="margin:0;background:${BRAND.soft};font-family:Segoe UI,Arial,sans-serif;color:${BRAND.text}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:14px;overflow:hidden;border:1px solid ${BRAND.line}">
<tr><td style="background:${BRAND.navy};padding:18px 24px;color:#fff;font-size:18px;font-weight:700">Aziz <span style="color:${BRAND.cyan}">HRM</span></td></tr>
<tr><td style="padding:24px"><h1 style="margin:0 0 12px;font-size:18px">${esc(title)}</h1>
<p style="margin:0 0 20px;line-height:1.55;color:#334155;white-space:pre-line">${esc(body)}</p>
${actionUrl ? `<a href="${esc(actionUrl)}" style="display:inline-block;background:${BRAND.royal};color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">Open in Aziz HRM</a>` : ''}
</td></tr>
<tr><td style="padding:14px 24px;border-top:1px solid ${BRAND.line};color:${BRAND.muted};font-size:12px">You received this because of your notification preferences in Aziz HRM.</td></tr>
</table></td></tr></table></body></html>`;
}
