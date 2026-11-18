import { resolve } from "node:path";
import PDFDocument from "pdfkit";
import { markets } from "../../config/markets.ts";
import { store } from "../../config/store.ts";
import type { OrderDocument } from "./order-document.ts";

const ink = "#191C2D";
const muted = "#4C5269";
const accent = "#322888";
const rule = "#DFE1EC";
const paper = "#F2F1FA";
const margin = 45;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// PDFKit shapes one script per text call. Split mixed labels and catalog data into
// runs so Bangla clusters still shape when a label starts with a Latin brand name.
function scriptRuns(text: string) {
  return text.match(/[\u0980-\u09ff\u200c\u200d]+|[^\u0980-\u09ff\u200c\u200d]+/gu) ?? [];
}

function drawDocument(doc: PDFKit.PDFDocument, data: OrderDocument) {
  const { minorDigits, locale } = markets[data.marketId];
  const number = new Intl.NumberFormat(locale);
  const decimal = new Intl.NumberFormat(locale, {
    minimumFractionDigits: minorDigits, maximumFractionDigits: minorDigits,
  });
  const money = (minor: number) => `${data.currency} ${decimal.format(minor / 10 ** minorDigits)}`;
  const right = doc.page.width - margin;
  const width = right - margin;
  const limit = doc.page.height - 71;
  let y = margin;

  function measure(content: string) {
    return scriptRuns(content).reduce((sum, run) => sum + doc.widthOfString(run), 0);
  }

  function words(content: string, maxWidth: number, size: number) {
    doc.fontSize(size);
    const result: string[] = [];
    let line = "";
    for (const word of content.trim().split(/\s+/u)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) result.push(line);
      line = "";
      if (measure(word) <= maxWidth) {
        line = word;
        continue;
      }
      for (const { segment } of graphemes.segment(word)) {
        if (line && measure(line + segment) > maxWidth) {
          result.push(line);
          line = "";
        }
        line += segment;
      }
    }
    if (line) result.push(line);
    return result;
  }

  function line(content: string, x: number, top: number, size: number, color = ink, endAligned = false) {
    doc.fillColor(color).fontSize(size);
    if (endAligned) x -= measure(content);
    if (!content) return;
    doc.markContent("Span", { actual: content });
    for (const run of scriptRuns(content)) {
      doc.text(run, x, top, { lineBreak: false });
      x += doc.widthOfString(run);
    }
    doc.endMarkedContent();
  }

  function horizontalRule(top: number, x = margin, end = right) {
    doc.moveTo(x, top).lineTo(end, top).lineWidth(0.7).strokeColor(rule).stroke();
  }

  function topBar() {
    line(store.name, margin, margin, 20, accent);
    line("STAGING PREVIEW", right, margin + 4, 10, accent, true);
    horizontalRule(margin + 37);
    y = margin + 55;
  }

  function nextPage() {
    doc.addPage();
    topBar();
    const title = `${data.title} · ${data.reference}`;
    const wrapped = words(title, width, 10);
    wrapped.forEach((value, index) => line(value, margin, y + index * 15, 10, muted));
    y += wrapped.length * 15 + 15;
  }

  function heading(content: string) {
    line(content, margin, y, 15);
    y += 28;
  }

  function itemHeader() {
    heading("Items in this order");
    doc.rect(margin, y, width, 27).fill(paper);
    line("Item", margin + 10, y + 6, 10, muted);
    line("Qty", right - 113, y + 6, 10, muted, true);
    if (data.items.some(item => item.minor !== undefined)) {
      line("Line total", right - 10, y + 6, 10, muted, true);
    }
    y += 32;
  }

  function amountRow(label: string, minor: number, prominent = false) {
    const x = margin + 101;
    const size = prominent ? 12 : 10;
    const labels = words(label, right - x - 125, size);
    const height = Math.max(1, labels.length) * 17;
    if (y + height + 5 > limit) nextPage();
    if (prominent) doc.rect(x - 8, y - 1, right - x + 8, height + 8).fill(paper);
    labels.forEach((value, index) => line(value, x, y + 3 + 17 * index, size, prominent ? accent : muted));
    line(money(minor), right - 10, y + 3, size, prominent ? accent : ink, true);
    y += height + (prominent ? 12 : 5);
  }

  topBar();
  line(data.title, margin, y, 30);
  y += 50;
  const reference = words(data.reference, width, 14);
  reference.forEach((value, index) => line(value, margin, y + 19 * index, 14, accent));
  y += 19 * reference.length + 22;

  for (let index = 0; index < data.details.length; index += 2) {
    const columnWidth = width / 2 - 20;
    const fields = data.details.slice(index, index + 2).map(field => ({ ...field, lines: words(field.value, columnWidth, 12) }));
    fields.forEach((field, column) => {
      const x = margin + column * (columnWidth + 25);
      line(field.label, x, y, 9, muted);
      field.lines.forEach((value, row) => line(value, x, y + 15 + row * 17, 12));
    });
    y += 23 + 17 * Math.max(...fields.map(field => Math.max(1, field.lines.length)));
  }

  if (data.items.length) {
    y += 10;
    itemHeader();
    for (const item of data.items) {
      const itemWidth = width - 156;
      const titles = words(item.title, itemWidth, 11);
      const details = words(item.detail, itemWidth, 9);
      const height = Math.max(1, titles.length) * 16 + details.length * 14 + 12;
      if (y + height > limit) {
        nextPage();
        itemHeader();
      }
      titles.forEach((value, index) => line(value, margin + 10, y + index * 16, 11));
      details.forEach((value, index) => line(value, margin + 10, y + titles.length * 16 + index * 14, 9, muted));
      line(number.format(item.quantity), right - 113, y, 11, ink, true);
      if (item.minor !== undefined) line(money(item.minor), right - 10, y, 11, ink, true);
      horizontalRule(y + height - 5);
      y += height;
    }
  }

  y += 12;
  if (y + (data.breakdown.length + data.payment.length + Number(Boolean(data.total))) * 25 > limit) nextPage();
  for (const row of data.breakdown) amountRow(row.label, row.minor);
  if (data.total) amountRow(data.total.label, data.total.minor, true);
  for (const row of data.payment) amountRow(row.label, row.minor);

  if (data.refunds.length) {
    y += 16;
    if (y + 60 > limit) nextPage();
    heading("Confirmed refunds");
    for (const refund of data.refunds) amountRow(refund.label, refund.minor);
    if (data.netPaid) amountRow(data.netPaid.label, data.netPaid.minor, true);
  }

  if (data.note) {
    y += 16;
    const note = words(data.note, width, 10);
    if (y + note.length * 15 > limit) nextPage();
    note.forEach((value, index) => line(value, margin, y + index * 15, 10, muted));
  }

  const { start, count } = doc.bufferedPageRange();
  for (let index = 0; index < count; index++) {
    doc.switchToPage(start + index);
    horizontalRule(doc.page.height - 63);
    line(store.supportEmail, margin, doc.page.height - 54, 9, muted);
    line(`${number.format(index + 1)} / ${number.format(count)}`, right, doc.page.height - 54, 9, muted, true);
  }
}

export async function orderDocumentPdf(data: OrderDocument) {
  // The OFL font sits under public/ so the standalone image ships its local copy.
  const font = resolve("public", "fonts", "NotoSansBengali.ttf");
  const doc = new PDFDocument({ size: data.marketId === "bd" ? "A4" : "LETTER", margin, font, bufferPages: true, lang: "en",
    info: { Title: `${data.title} ${data.reference}`, Author: store.name } });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const pdf = new Promise<Buffer>((done, fail) => {
    doc.once("end", () => done(Buffer.concat(chunks)));
    doc.once("error", fail);
  });
  try {
    drawDocument(doc, data);
    // Fontkit adds a few display-only glyphs when shaping Bangla. PDFKit 0.20
    // encodes those as empty ToUnicode entries, which can invalidate a reader's
    // whole character map. Give them a zero-width mapping. ActualText preserves
    // the original spelling and character order for readers that support it.
    const fontMap = (doc as PDFKit.PDFDocument & { _font?: { unicode?: number[][] } })._font?.unicode;
    fontMap?.forEach((codePoints, index) => {
      if (!codePoints.length) fontMap[index] = [0x200b];
    });
    doc.end();
  } catch (error) {
    doc.destroy(error instanceof Error ? error : new Error("Could not generate order document."));
  }
  return pdf;
}
