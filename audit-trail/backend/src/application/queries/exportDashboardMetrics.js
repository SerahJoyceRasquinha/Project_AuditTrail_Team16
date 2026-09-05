import PDFDocument from 'pdfkit';
import { AppError } from '../../shared/errors/AppError.js';
import { METRIC_DEFINITIONS, CHART_DEFINITIONS, METRICS_BASIS } from './metricDefinitions.js';

/**
 * Dashboard export - PDF and CSV.
 *
 * The dashboard is the screen someone takes into a meeting, which is exactly
 * the situation where a screenshot stops being enough: the numbers need to
 * arrive with their definitions attached. So this report is not a dump of the
 * metrics payload. Every figure is printed next to what it counts, in plain
 * English and in technical terms, with the arithmetic stated - because a KPI
 * with no stated formula gets re-derived by guesswork the first time somebody
 * disputes it.
 *
 * The charts are redrawn here rather than captured from the browser. Rasterising
 * the on-screen SVG would have meant shipping a headless browser or trusting the
 * client to upload an image it claims is its own chart; drawing them from the
 * same numbers the tables use means the picture and the table cannot disagree,
 * and the export works from curl with no browser involved at all.
 *
 * Both formats are generated on the server for the same reason the shipment
 * audit export is: an exported figure should not depend on what the operator
 * had typed into a filter box at the time.
 */

const PALETTE = {
  ink: '#12212e',
  muted: '#5b6b7a',
  hairline: '#d7dee5',
  panel: '#f2f6f9',
  accent: '#0f6f78',
  alert: '#b4462b',
  warn: '#a5691a',
  ok: '#2c6e49',
  blue: '#2d6cb5',
};

/** Chart slice colours, matching the dashboard's semantic slots. */
const SERIES_COLOURS = [PALETTE.accent, PALETTE.warn, PALETTE.ok, PALETTE.blue, PALETTE.alert];

const PAGE_MARGIN = 48;

// --- shared formatting -------------------------------------------------------

/** Renders a metric value for display, honouring its unit. */
export function formatMetricValue(key, value, unit = '') {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') {
    const shown = Number.isInteger(value) ? String(value) : value.toFixed(2);
    return `${shown}${unit}`;
  }
  return String(value);
}

const csvCell = (value) => {
  const text =
    typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
};

const csvRow = (cells) => cells.map(csvCell).join(',');

/**
 * The breakdown metrics are objects rather than scalars, so they are flattened
 * into one row per entry instead of being stringified into a single cell that
 * nothing downstream could read.
 */
function breakdownRows(definition, value) {
  return Object.entries(value ?? {}).map(([name, count]) =>
    csvRow([definition.label, name, count, '', definition.plain, definition.technical, definition.formula])
  );
}

/**
 * CSV.
 *
 * One row per metric, with both explanations and the formula as columns, so the
 * file is self-describing when it is opened months later by someone who was not
 * in the meeting. The BOM is there so Excel opens the accented place names as
 * UTF-8 instead of mojibake.
 */
export function buildDashboardCsv(metrics) {
  const lines = [];

  lines.push(csvRow(['Audit Trail — shipment dashboard metrics']));
  lines.push(csvRow(['Generated at', metrics.generatedAt ?? new Date().toISOString()]));
  lines.push(csvRow(['Source', METRICS_BASIS.source]));
  lines.push(csvRow(['Scope', METRICS_BASIS.scope]));
  lines.push(csvRow(['Freshness', METRICS_BASIS.freshness]));
  lines.push('');

  lines.push(
    csvRow([
      'Metric',
      'Breakdown',
      'Value',
      'Unit',
      'What it means (plain English)',
      'How it is derived (technical)',
      'Formula',
    ])
  );

  for (const definition of METRIC_DEFINITIONS) {
    const value = metrics[definition.key];
    if (value !== null && typeof value === 'object') {
      lines.push(...breakdownRows(definition, value));
      continue;
    }
    lines.push(
      csvRow([
        definition.label,
        '',
        value ?? '',
        definition.unit.trim(),
        definition.plain,
        definition.technical,
        definition.formula,
      ])
    );
  }

  lines.push('');
  lines.push(csvRow(['Charts included in the PDF export']));
  lines.push(csvRow(['Chart', 'Type', 'What it shows (plain English)', 'How it is built (technical)']));
  for (const chart of CHART_DEFINITIONS) {
    lines.push(csvRow([chart.title, chart.type, chart.plain, chart.technical]));
  }

  // A BOM, then CRLF line endings, which is what spreadsheet software expects.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

// --- PDF drawing helpers -----------------------------------------------------

function heading(doc, text) {
  if (doc.y > doc.page.height - PAGE_MARGIN - 90) doc.addPage();
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(13).fillColor(PALETTE.ink).text(text);
  doc
    .moveTo(PAGE_MARGIN, doc.y + 3)
    .lineTo(doc.page.width - PAGE_MARGIN, doc.y + 3)
    .strokeColor(PALETTE.hairline)
    .lineWidth(1)
    .stroke();
  doc.moveDown(0.7);
}

/**
 * One metric, printed as a value with both explanations underneath.
 *
 * The block is measured before it is drawn and moved whole to the next page if
 * it will not fit, because a definition split across a page break is the one
 * part of this document that most needs to be read in one piece.
 */
function metricBlock(doc, definition, value) {
  const width = doc.page.width - PAGE_MARGIN * 2;
  const shown = formatMetricValue(definition.key, value, definition.unit);

  const heightNeeded =
    28 +
    doc.font('Helvetica').fontSize(9).heightOfString(definition.plain, { width: width - 12 }) +
    doc.font('Helvetica').fontSize(9).heightOfString(definition.technical, { width: width - 12 }) +
    doc.font('Helvetica-Oblique').fontSize(8).heightOfString(definition.formula, { width: width - 12 }) +
    26;

  if (doc.y + heightNeeded > doc.page.height - PAGE_MARGIN) doc.addPage();

  const top = doc.y;
  doc.font('Helvetica-Bold').fontSize(10).fillColor(PALETTE.ink).text(definition.label, PAGE_MARGIN + 6, top);
  doc
    .font('Helvetica-Bold')
    .fontSize(16)
    .fillColor(PALETTE.accent)
    .text(shown, PAGE_MARGIN + 6, doc.y + 1);

  doc.moveDown(0.25);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(PALETTE.muted).text('IN PLAIN ENGLISH', PAGE_MARGIN + 6);
  doc.font('Helvetica').fontSize(9).fillColor(PALETTE.ink).text(definition.plain, PAGE_MARGIN + 6, doc.y, {
    width: width - 12,
  });

  doc.moveDown(0.25);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(PALETTE.muted).text('TECHNICALLY', PAGE_MARGIN + 6);
  doc.font('Helvetica').fontSize(9).fillColor(PALETTE.ink).text(definition.technical, PAGE_MARGIN + 6, doc.y, {
    width: width - 12,
  });

  doc.moveDown(0.2);
  doc
    .font('Helvetica-Oblique')
    .fontSize(8)
    .fillColor(PALETTE.muted)
    .text(`Formula:  ${definition.formula}`, PAGE_MARGIN + 6, doc.y, { width: width - 12 });

  doc.moveDown(0.5);
  doc
    .moveTo(PAGE_MARGIN, doc.y)
    .lineTo(doc.page.width - PAGE_MARGIN, doc.y)
    .strokeColor(PALETTE.hairline)
    .lineWidth(0.5)
    .stroke();
  doc.moveDown(0.5);
}

/**
 * A pie chart, drawn from the same numbers the tables use.
 *
 * The all-zero case is handled explicitly rather than left to produce a
 * zero-radius arc: an empty fleet should say it is empty, not render a
 * mysterious blank circle.
 */
function pieChart(doc, { title, slices, x, y, radius }) {
  doc.font('Helvetica-Bold').fontSize(10).fillColor(PALETTE.ink).text(title, x - radius, y - radius - 22, {
    width: radius * 2,
    align: 'center',
  });

  const total = slices.reduce((sum, slice) => sum + slice.value, 0);

  if (total <= 0) {
    doc.circle(x, y, radius).strokeColor(PALETTE.hairline).lineWidth(1).stroke();
    doc
      .font('Helvetica-Oblique')
      .fontSize(8)
      .fillColor(PALETTE.muted)
      .text('No data yet', x - radius, y - 4, { width: radius * 2, align: 'center' });
    return y + radius + 16;
  }

  let angle = -Math.PI / 2;
  slices.forEach((slice, index) => {
    if (slice.value <= 0) return;
    const sweep = (slice.value / total) * Math.PI * 2;
    doc.save();
    doc.moveTo(x, y);
    doc.lineTo(x + radius * Math.cos(angle), y + radius * Math.sin(angle));
    // pdfkit's arc is expressed in degrees, measured clockwise from 3 o'clock.
    doc.path(
      `M ${x} ${y} L ${x + radius * Math.cos(angle)} ${y + radius * Math.sin(angle)} ` +
        `A ${radius} ${radius} 0 ${sweep > Math.PI ? 1 : 0} 1 ` +
        `${x + radius * Math.cos(angle + sweep)} ${y + radius * Math.sin(angle + sweep)} Z`
    );
    doc.fillColor(slice.color ?? SERIES_COLOURS[index % SERIES_COLOURS.length]).fill();
    doc.restore();
    angle += sweep;
  });

  /**
   * Legend, below the pie, one row per slice.
   *
   * The share in brackets is omitted when the slice value is already a
   * percentage, because "67% (67%)" reads as though two different things are
   * being reported when it is one number printed twice.
   */
  let legendY = y + radius + 12;
  slices.forEach((slice, index) => {
    doc
      .rect(x - radius, legendY, 8, 8)
      .fillColor(slice.color ?? SERIES_COLOURS[index % SERIES_COLOURS.length])
      .fill();

    const alreadyAPercentage = slice.suffix === '%';
    const share = alreadyAPercentage ? '' : ` (${Math.round((slice.value / total) * 100)}%)`;

    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(PALETTE.ink)
      .text(`${slice.name} — ${slice.value}${slice.suffix ?? ''}${share}`, x - radius + 13, legendY, {
        width: radius * 2 - 13,
      });
    legendY += 12;
  });

  return legendY;
}

/** A horizontal bar chart, which handles long place names better than vertical bars. */
function barChart(doc, { title, bars, x, y, width, barHeight = 16 }) {
  doc.font('Helvetica-Bold').fontSize(10).fillColor(PALETTE.ink).text(title, x, y);
  let cursor = doc.y + 6;

  if (bars.length === 0) {
    doc.font('Helvetica-Oblique').fontSize(8).fillColor(PALETTE.muted).text('No data yet', x, cursor);
    return doc.y + 6;
  }

  const max = Math.max(...bars.map((bar) => bar.value), 1);
  const labelWidth = Math.min(190, width * 0.45);
  const trackWidth = width - labelWidth - 34;

  for (const [index, bar] of bars.entries()) {
    if (cursor + barHeight > doc.page.height - PAGE_MARGIN) {
      doc.addPage();
      cursor = PAGE_MARGIN;
    }

    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(PALETTE.ink)
      .text(bar.name, x, cursor + 3, { width: labelWidth - 6, ellipsis: true, lineBreak: false });

    doc.rect(x + labelWidth, cursor, trackWidth, barHeight - 4).fillColor(PALETTE.panel).fill();
    doc
      .rect(x + labelWidth, cursor, Math.max((bar.value / max) * trackWidth, 1), barHeight - 4)
      .fillColor(SERIES_COLOURS[index % SERIES_COLOURS.length])
      .fill();
    doc
      .font('Helvetica-Bold')
      .fontSize(8)
      .fillColor(PALETTE.ink)
      .text(String(bar.value), x + labelWidth + trackWidth + 6, cursor + 3, { width: 26 });

    cursor += barHeight + 2;
  }

  return cursor;
}

function chartCaption(doc, chart, y) {
  const width = doc.page.width - PAGE_MARGIN * 2;
  doc.y = y + 6;
  if (doc.y > doc.page.height - PAGE_MARGIN - 60) doc.addPage();
  doc.font('Helvetica-Bold').fontSize(8).fillColor(PALETTE.muted).text('IN PLAIN ENGLISH', PAGE_MARGIN);
  doc.font('Helvetica').fontSize(9).fillColor(PALETTE.ink).text(chart.plain, PAGE_MARGIN, doc.y, { width });
  doc.moveDown(0.2);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(PALETTE.muted).text('TECHNICALLY', PAGE_MARGIN);
  doc.font('Helvetica').fontSize(9).fillColor(PALETTE.ink).text(chart.technical, PAGE_MARGIN, doc.y, { width });
  doc.moveDown(0.8);
}

// --- PDF ---------------------------------------------------------------------

export function writeDashboardPdf(doc, metrics) {
  const width = doc.page.width - PAGE_MARGIN * 2;
  const generatedAt = metrics.generatedAt ?? new Date().toISOString();

  // Cover block
  doc.font('Helvetica-Bold').fontSize(20).fillColor(PALETTE.ink).text('Shipment Dashboard');
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor(PALETTE.muted)
    .text('Audit Trail — event-sourced inventory & logistics ledger');
  doc.moveDown(0.4);
  doc.font('Helvetica').fontSize(9).fillColor(PALETTE.muted).text(`Generated ${generatedAt}`);
  doc.moveDown(0.8);

  // How to read this report - stated once, up front.
  const basisTop = doc.y;
  doc.rect(PAGE_MARGIN, basisTop, width, 74).fillColor(PALETTE.panel).fill();
  doc.font('Helvetica-Bold').fontSize(9).fillColor(PALETTE.ink).text('How to read this report', PAGE_MARGIN + 10, basisTop + 8);
  doc.font('Helvetica').fontSize(8.5).fillColor(PALETTE.ink);
  doc.text(`Source.  ${METRICS_BASIS.source}`, PAGE_MARGIN + 10, doc.y + 2, { width: width - 20 });
  doc.text(`Scope.  ${METRICS_BASIS.scope}`, PAGE_MARGIN + 10, doc.y + 1, { width: width - 20 });
  doc.text(`Freshness.  ${METRICS_BASIS.freshness}`, PAGE_MARGIN + 10, doc.y + 1, { width: width - 20 });
  doc.y = basisTop + 82;

  // --- Charts, each with its caption ---------------------------------------
  heading(doc, 'Charts');

  const stateSlices = Object.entries(metrics.byState ?? {}).map(([name, value], index) => ({
    name,
    value,
    color: SERIES_COLOURS[index % SERIES_COLOURS.length],
  }));

  let afterPie = pieChart(doc, {
    title: 'By Lifecycle State',
    slices: stateSlices,
    x: PAGE_MARGIN + 90,
    y: doc.y + 100,
    radius: 62,
  });
  chartCaption(doc, CHART_DEFINITIONS[0], afterPie);

  const compliance = metrics.overallTemperatureCompliance ?? 0;
  afterPie = pieChart(doc, {
    title: 'Temperature Compliance',
    slices: [
      { name: 'Compliant', value: compliance, suffix: '%', color: PALETTE.ok },
      { name: 'Breached', value: 100 - compliance, suffix: '%', color: PALETTE.alert },
    ],
    x: PAGE_MARGIN + 90,
    y: doc.y + 100,
    radius: 62,
  });
  chartCaption(doc, CHART_DEFINITIONS[1], afterPie);

  const toBars = (map) => Object.entries(map ?? {}).map(([name, value]) => ({ name, value }));

  let afterBars = barChart(doc, {
    title: 'Shipments by Origin',
    bars: toBars(metrics.shipmentsByOrigin),
    x: PAGE_MARGIN,
    y: doc.y,
    width,
  });
  chartCaption(doc, CHART_DEFINITIONS[2], afterBars);

  afterBars = barChart(doc, {
    title: 'Shipments by Destination',
    bars: toBars(metrics.shipmentsByDestination),
    x: PAGE_MARGIN,
    y: doc.y,
    width,
  });
  chartCaption(doc, CHART_DEFINITIONS[3], afterBars);

  // --- Every metric, explained ---------------------------------------------
  doc.addPage();
  heading(doc, 'Every metric, explained');

  for (const definition of METRIC_DEFINITIONS) {
    const value = metrics[definition.key];

    if (value !== null && typeof value === 'object') {
      // A breakdown: print the entries, then the shared explanation.
      if (doc.y > doc.page.height - PAGE_MARGIN - 120) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(10).fillColor(PALETTE.ink).text(definition.label, PAGE_MARGIN + 6);
      doc.moveDown(0.2);
      const entries = Object.entries(value);
      if (entries.length === 0) {
        doc.font('Helvetica-Oblique').fontSize(9).fillColor(PALETTE.muted).text('No data yet', PAGE_MARGIN + 6);
      } else {
        for (const [name, count] of entries) {
          doc
            .font('Helvetica')
            .fontSize(9)
            .fillColor(PALETTE.ink)
            .text(`${name}:  ${count}`, PAGE_MARGIN + 12, doc.y, { width: width - 18 });
        }
      }
      doc.moveDown(0.3);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(PALETTE.muted).text('IN PLAIN ENGLISH', PAGE_MARGIN + 6);
      doc.font('Helvetica').fontSize(9).fillColor(PALETTE.ink).text(definition.plain, PAGE_MARGIN + 6, doc.y, { width: width - 12 });
      doc.moveDown(0.2);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(PALETTE.muted).text('TECHNICALLY', PAGE_MARGIN + 6);
      doc.font('Helvetica').fontSize(9).fillColor(PALETTE.ink).text(definition.technical, PAGE_MARGIN + 6, doc.y, { width: width - 12 });
      doc.moveDown(0.2);
      doc
        .font('Helvetica-Oblique')
        .fontSize(8)
        .fillColor(PALETTE.muted)
        .text(`Formula:  ${definition.formula}`, PAGE_MARGIN + 6, doc.y, { width: width - 12 });
      doc.moveDown(0.5);
      doc
        .moveTo(PAGE_MARGIN, doc.y)
        .lineTo(doc.page.width - PAGE_MARGIN, doc.y)
        .strokeColor(PALETTE.hairline)
        .lineWidth(0.5)
        .stroke();
      doc.moveDown(0.5);
      continue;
    }

    metricBlock(doc, definition, value);
  }
}

// --- Handler -----------------------------------------------------------------

export class ExportDashboardMetricsQueryHandler {
  #dashboardMetrics;

  constructor({ dashboardMetricsQueryHandler }) {
    this.#dashboardMetrics = dashboardMetricsQueryHandler;
  }

  async handle({ format, res }) {
    const requested = String(format ?? 'pdf').toLowerCase();
    if (!['pdf', 'csv'].includes(requested)) {
      throw new AppError('The report format must be csv or pdf.', {
        status: 400,
        code: 'INVALID_FORMAT',
      });
    }

    const metrics = await this.#dashboardMetrics.handle();
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `shipment-dashboard-${stamp}.${requested}`;

    if (requested === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(buildDashboardCsv(metrics));
      return;
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, bufferPages: true });
    doc.pipe(res);
    writeDashboardPdf(doc, metrics);
    doc.end();
  }
}
