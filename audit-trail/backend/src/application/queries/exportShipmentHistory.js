import PDFDocument from 'pdfkit';
import { validateShipmentId } from '../../domain/shipment/validators/commandValidators.js';
import {
  buildShipmentReport,
  formatInstant,
  formatPlanDate,
  formatTemp,
} from './shipmentReport.js';

/**
 * Shipment audit report - PDF and CSV.
 *
 * The report this replaced printed a diff of internal state at every version:
 * `temperatureBreachCount: 0 -> 1`, `currentState: "IN_TRANSIT" -> "AT_PORT"`.
 * Every fact was in there somewhere, and none of it was legible to the person
 * the report is for.
 *
 * The rewrite is organised around a reader who has never seen the schema, while
 * remaining usable as evidence. Four things it is careful about:
 *
 *  - **It never implies stored state where there is reconstructed state.** The
 *    status panel is headed "reconstructed by replaying N records", because
 *    that is what it is. Presenting it as a stored row would be a false claim
 *    about how the system works.
 *  - **Plans and facts are visually separated.** A tentative date and a
 *    confirmed arrival are different kinds of thing, and the reader is never
 *    left to work out which one they are looking at.
 *  - **Simulated readings are labelled as simulated,** in the section header
 *    and in the row.
 *  - **It stays readable at length.** Long histories paginate with repeating
 *    headers, and very long temperature series keep every alert in full while
 *    thinning the in-range readings - the alerts are the forensically
 *    interesting part.
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
};

const PAGE_MARGIN = 48;
const MAX_DETAILED_READINGS = 60;

export class ExportShipmentHistoryQueryHandler {
  #replayService;
  #eventStore;

  constructor({ replayService, eventStore }) {
    this.#replayService = replayService;
    this.#eventStore = eventStore;
  }

  async handle({ shipmentId, format, res }) {
    validateShipmentId(shipmentId);

    const events = await this.#eventStore.getEvents(shipmentId);
    if (events.length === 0) {
      res.status(404).json({
        error: {
          code: 'AGGREGATE_NOT_FOUND',
          message: `No shipment was found with the reference ${shipmentId}.`,
        },
      });
      return;
    }

    const integrity = await this.#eventStore.verifyChain(shipmentId);
    const report = buildShipmentReport({ events, integrity });

    if (format === 'csv') {
      this.#generateCsv(report, res);
    } else if (format === 'pdf') {
      this.#generatePdf(report, res);
    } else {
      res.status(400).json({
        error: { code: 'INVALID_FORMAT', message: 'The report format must be csv or pdf.' },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // CSV
  // ---------------------------------------------------------------------------

  /**
   * The spreadsheet-shaped view of the same report, not a second interpretation
   * of the data. It leads with a summary block so a downloaded file is
   * self-describing, then uses the same business labels the PDF prints.
   */
  #generateCsv(report, res) {
    const id = report.identification.shipmentId;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${id}-audit-report.csv"`);

    const cell = (value) => {
      const text = value === null || value === undefined ? '' : String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const row = (...values) => `${values.map(cell).join(',')}\n`;

    res.write('\ufeff');
    res.write(row('Shipment audit report'));
    res.write(row('Shipment reference', id));
    res.write(row('Container', report.identification.containerCode));
    res.write(row('Origin', report.origin.display));
    res.write(row('Destination', report.destination.display));
    res.write(row('Opened', formatInstant(report.creation.openedAt)));
    res.write(row('Current status', report.currentStatus.label));
    res.write(
      row(
        'Status basis',
        `Reconstructed by replaying ${report.integrity.eventCount} recorded events; not stored as editable state`
      )
    );
    res.write(row('Originally estimated duration (days)', report.duration.originalEstimateDays));
    res.write(row('Current estimated duration (days)', report.duration.currentEstimateDays));
    res.write(row('Temperature alerts', report.temperature.alertCount));
    res.write(
      row(
        'Record integrity',
        report.integrity.intact
          ? `Hash chain verified intact: true as of ${report.integrity.verifiedAt}`
          : 'WARNING: Hash chain tampered. Integrity intact: false'
      )
    );
    res.write(row('Report generated', formatInstant(report.generatedAt)));
    res.write('\n');

    res.write(row('Planned lifecycle stages'));
    res.write(
      row('Stage', 'Status', 'Originally planned', 'Currently planned', 'Actually confirmed', 'Variance (days)')
    );
    for (const stage of report.lifecycle) {
      res.write(
        row(
          stage.label,
          stage.statusLabel,
          formatPlanDate(stage.originalPlannedDate),
          formatPlanDate(stage.plannedDate),
          stage.confirmedAt ? formatInstant(stage.confirmedAt) : '',
          stage.varianceDays ?? ''
        )
      );
    }
    res.write('\n');

    res.write(row('Recorded history'));
    res.write(row('Version', 'Event Type', 'Timestamp', 'What happened', 'Details'));
    for (const entry of report.history) {
      res.write(row(entry.version, entry.eventType, entry.at, entry.label, entry.summary));
    }
    res.write('\n');

    res.write(row('Temperature observations'));
    res.write(row('Version', 'Observed at (UTC)', 'Temperature (C)', 'Alert', 'Origin of reading'));
    for (const reading of report.temperature.readings) {
      res.write(
        row(
          reading.version,
          formatInstant(reading.at),
          reading.temperatureC,
          reading.isAlert ? 'ALERT' : '',
          reading.sourceLabel
        )
      );
    }
    res.write('\n');
    res.write(
      row(
        'Integrity Statement',
        report.integrity.intact
          ? `Hash chain verified intact: true as of ${report.integrity.verifiedAt}`
          : 'WARNING: Hash chain tampered. Integrity intact: false'
      )
    );

    res.end();
  }

  // ---------------------------------------------------------------------------
  // PDF
  // ---------------------------------------------------------------------------

  #generatePdf(report, res) {
    const id = report.identification.shipmentId;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${id}-audit-report.pdf"`);

    const doc = new PDFDocument({
      margin: PAGE_MARGIN,
      size: 'A4',
      bufferPages: true,
      info: {
        Title: `Shipment audit report - ${id}`,
        Author: 'Audit Trail',
        Subject: 'Immutable shipment history and reconstructed status',
      },
    });
    doc.pipe(res);

    const layout = new PdfLayout(doc);

    this.#coverBlock(layout, report);
    this.#identificationSection(layout, report);
    this.#routeSection(layout, report);
    this.#statusSection(layout, report);
    this.#durationSection(layout, report);
    this.#lifecycleSection(layout, report);
    this.#scheduleChangeSection(layout, report);
    this.#temperatureSection(layout, report);
    this.#alertSection(layout, report);
    this.#historySection(layout, report);
    this.#integritySection(layout, report);

    layout.paginate(report);
    doc.end();
  }

  #coverBlock(layout, report) {
    const { doc } = layout;

    doc.font('Helvetica-Bold').fontSize(19).fillColor(PALETTE.ink).text('Shipment Audit Report');
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor(PALETTE.muted)
      .text(
        'A complete, tamper-evident record of this shipment, reconstructed from its history. Every entry below was recorded when it happened and has not been altered since.'
      );
    doc.moveDown(0.8);

    const banner = report.integrity.intact
      ? {
          tone: PALETTE.ok,
          title: 'Record verified',
          body: `All ${report.integrity.eventCount} records are intact and in sequence. Verified ${formatInstant(report.integrity.verifiedAt)}.`,
        }
      : {
          tone: PALETTE.alert,
          title: 'Record integrity compromised - intact: false',
          body: `This history failed verification (${report.integrity.issues.length} issue(s) found). It must not be relied upon as evidence until investigated.`,
        };

    layout.calloutBox(banner.tone, banner.title, banner.body);

    if (report.currentStatus.archived) {
      layout.calloutBox(
        PALETTE.muted,
        'Withdrawn from the active fleet',
        `Withdrawn on ${formatInstant(report.currentStatus.archivedAt)}. Nothing was deleted - the full history below remains intact and verifiable.`
      );
    }

    if (report.isOverdue) {
      layout.calloutBox(
        PALETTE.warn,
        'This shipment is overdue',
        'One or more lifecycle stages passed their planned date without being confirmed. See "Shipment schedule" below.'
      );
    }
  }

  #identificationSection(layout, report) {
    layout.sectionHeading('1. Shipment identification');
    layout.fieldGrid([
      ['Shipment reference', report.identification.shipmentId],
      ['Container', report.identification.containerCode ?? '-'],
      ['Cargo', report.identification.cargo ?? 'Not specified'],
      ['Carrier', report.identification.carrier ?? 'Not specified'],
      ['Vessel', report.identification.vessel ?? 'Not yet assigned'],
      ['Voyage', report.identification.voyage ?? '-'],
    ]);
  }

  #routeSection(layout, report) {
    layout.sectionHeading('2. Origin and destination');
    layout.fieldGrid([
      ['Origin', report.origin.display],
      ['Destination', report.destination.display],
      ['Origin country', report.origin.country ?? 'As recorded (free text)'],
      ['Destination country', report.destination.country ?? 'As recorded (free text)'],
      ['Origin region', report.origin.state ?? '-'],
      ['Destination region', report.destination.state ?? '-'],
    ]);

    if (!report.origin.verified || !report.destination.verified) {
      layout.note(
        'One or both locations were recorded as free text before structured country and region selection was introduced. They are reproduced exactly as recorded; earlier records are never rewritten.'
      );
    }
  }

  #statusSection(layout, report) {
    layout.sectionHeading('3. Current status');
    layout.note(
      `The status below is not a stored, editable field. It was reconstructed by replaying all ${report.integrity.eventCount} historical records in order - which is why it can be trusted to match the history that follows.`
    );
    layout.fieldGrid([
      ['Status', report.currentStatus.label],
      ['Current location', report.currentStatus.location ?? '-'],
      ['Last activity', formatInstant(report.currentStatus.lastActivityAt)],
      ['Records on file', String(report.integrity.eventCount)],
    ]);
  }

  #durationSection(layout, report) {
    layout.sectionHeading('4. Creation and planned duration');

    const rows = [
      ['Shipment opened', formatInstant(report.creation.openedAt)],
      [
        'Originally estimated',
        report.duration.originalEstimateDays ? `${report.duration.originalEstimateDays} days` : 'Not recorded',
      ],
      ['Originally due', formatPlanDate(report.duration.originalCompletion)],
      [
        'Currently estimated',
        report.duration.currentEstimateDays ? `${report.duration.currentEstimateDays} days` : 'Not recorded',
      ],
      ['Currently due', formatPlanDate(report.duration.currentCompletion)],
      [
        'Delays recorded',
        report.duration.wasExtended
          ? `${report.duration.extensionCount} extension(s), ${report.duration.totalExtensionDays} days total`
          : 'None',
      ],
    ];

    if (report.duration.actualCompletionAt) {
      rows.push(['Actually completed', formatInstant(report.duration.actualCompletionAt)]);
      rows.push(['Actual duration', `${report.duration.actualDurationDays} days`]);
    }

    layout.fieldGrid(rows);

    if (report.creation.backfilled) {
      layout.note(
        `This shipment was entered into the ledger after the fact: it records an opening time of ${formatInstant(report.creation.openedAt)} but was written to the system at ${formatInstant(report.creation.recordedAt)}. Both times are preserved and neither can be edited.`
      );
    }

    if (Number.isInteger(report.duration.finishedEarlyByDays) && report.duration.finishedEarlyByDays !== 0) {
      const early = report.duration.finishedEarlyByDays > 0;
      layout.calloutBox(
        early ? PALETTE.ok : PALETTE.warn,
        early ? 'Completed ahead of the original estimate' : 'Completed later than the original estimate',
        `Originally estimated at ${report.duration.originalEstimateDays} days and actually completed in ${report.duration.actualDurationDays} - ${Math.abs(report.duration.finishedEarlyByDays)} day(s) ${early ? 'early' : 'late'}.`
      );
    }
  }

  #lifecycleSection(layout, report) {
    layout.sectionHeading('5. Shipment schedule and lifecycle');

    if (!report.schedulePlanned) {
      layout.note('No schedule has been agreed for this shipment yet.');
      return;
    }

    layout.note(
      'Planned dates are intentions, not events. A stage becomes a confirmed fact only in the "Actually confirmed" column, and only when it was recorded at the time.'
    );

    layout.table(
      [
        { label: 'Stage', width: 110 },
        { label: 'Status', width: 70 },
        { label: 'Originally planned', width: 90 },
        { label: 'Currently planned', width: 90 },
        { label: 'Actually confirmed', width: 139 },
      ],
      report.lifecycle.map((stage) => {
        let tone = PALETTE.ink;
        if (stage.status === 'OVERDUE') tone = PALETTE.alert;
        else if (stage.status === 'CONFIRMED') tone = PALETTE.ok;

        let confirmed = '-';
        if (stage.confirmedAt) {
          confirmed = formatInstant(stage.confirmedAt);
          if (stage.earlyByDays > 0) confirmed += ` (${stage.earlyByDays}d early)`;
          if (stage.lateByDays > 0) confirmed += ` (${stage.lateByDays}d late)`;
        } else if (stage.status === 'OVERDUE') {
          confirmed = `Overdue by ${stage.overdueByDays} day(s)`;
        }

        return {
          tone,
          cells: [
            stage.label,
            stage.statusLabel,
            formatPlanDate(stage.originalPlannedDate),
            stage.wasRescheduled ? `${formatPlanDate(stage.plannedDate)} *` : formatPlanDate(stage.plannedDate),
            confirmed,
          ],
        };
      })
    );

    if (report.lifecycle.some((stage) => stage.wasRescheduled)) {
      layout.note('* This date was changed after the schedule was first agreed. The change is itemised in section 6.');
    }

    const withDetails = report.lifecycle.filter(
      (stage) => stage.details && Object.values(stage.details).some(Boolean)
    );
    if (withDetails.length > 0) {
      layout.subHeading('Stage details as planned');
      for (const stage of withDetails) {
        const parts = Object.entries(stage.details)
          .filter(([, value]) => value)
          .map(([key, value]) => `${humanise(key)}: ${value}`);
        layout.bullet(`${stage.label} - ${parts.join('; ')}`);
      }
    }
  }

  #scheduleChangeSection(layout, report) {
    if (report.scheduleChanges.length === 0) return;

    layout.sectionHeading('6. Changes to the schedule');
    layout.note(
      'Each change below was recorded as its own permanent entry. Previous plans were never overwritten, so the original commitment remains readable alongside every revision.'
    );

    for (const change of report.scheduleChanges) {
      const tone = change.kind === 'SHIPMENT_SCHEDULE_EXTENDED' ? PALETTE.warn : PALETTE.ink;
      layout.ensureSpace(70);
      layout.doc
        .font('Helvetica-Bold')
        .fontSize(9.5)
        .fillColor(tone)
        .text(`${change.label} - ${formatInstant(change.at)}  (record no. ${change.version})`);

      if (change.extensionDays) {
        layout.doc
          .font('Helvetica')
          .fontSize(9)
          .fillColor(PALETTE.ink)
          .text(`Delay of ${change.extensionDays} day(s) affecting ${change.stage ?? 'the voyage'}.`, {
            indent: 12,
          });
      }
      if (change.reason) {
        layout.doc
          .font('Helvetica-Oblique')
          .fontSize(9)
          .fillColor(PALETTE.muted)
          .text(`Reason given: ${change.reason}`, { indent: 12 });
      }
      for (const detail of change.changes) {
        layout.doc
          .font('Helvetica')
          .fontSize(9)
          .fillColor(PALETTE.ink)
          .text(
            `${detail.stage}: ${formatPlanDate(detail.from)} -> ${formatPlanDate(detail.to)}${
              detail.shiftedByDays
                ? ` (${detail.shiftedByDays > 0 ? '+' : ''}${detail.shiftedByDays} days)`
                : ''
            }`,
            { indent: 12 }
          );
      }
      layout.doc.moveDown(0.5);
    }
  }

  #temperatureSection(layout, report) {
    layout.sectionHeading('7. Temperature monitoring');
    const t = report.temperature;

    if (!t.hasRange) {
      layout.note('No temperature range was agreed for this shipment, so no reading can be classed as a breach.');
    }

    layout.fieldGrid([
      [
        'Agreed range',
        t.hasRange ? `${formatTemp(t.declaredMinC)} to ${formatTemp(t.declaredMaxC)}` : 'None agreed',
      ],
      ['Observations', String(t.readingCount)],
      ['Alerts raised', String(t.alertCount)],
      ['Lowest observed', formatTemp(t.lowestC)],
      ['Highest observed', formatTemp(t.highestC)],
      ['Average observed', formatTemp(t.averageC)],
    ]);

    if (t.readingCount === 0) {
      layout.note('No temperature observations have been recorded for this shipment.');
      return;
    }

    layout.note(
      `Origin of readings: ${t.sources.join(', ')}. Monitoring ran from ${formatInstant(t.firstReadingAt)} to ${formatInstant(t.lastReadingAt)}.`
    );

    const detailed = t.readings.length <= MAX_DETAILED_READINGS;
    const shown = detailed
      ? t.readings
      : t.readings.filter(
          (reading, index) =>
            reading.isAlert || index % Math.ceil(t.readings.length / MAX_DETAILED_READINGS) === 0
        );

    if (!detailed) {
      layout.note(
        `${t.readingCount} observations were recorded. All ${t.alertCount} alerts are shown in full below, together with a representative sample of the in-range readings. The complete series is available in the CSV report.`
      );
    }

    layout.subHeading('Observations');
    layout.table(
      [
        { label: 'Record no.', width: 60 },
        { label: 'Observed at (UTC)', width: 150 },
        { label: 'Temperature', width: 80 },
        { label: 'Assessment', width: 209 },
      ],
      shown.map((reading) => ({
        tone: reading.isAlert ? PALETTE.alert : PALETTE.ink,
        cells: [
          String(reading.version),
          formatInstant(reading.at),
          formatTemp(reading.temperatureC),
          reading.isAlert
            ? `ALERT - ${reading.direction === 'BELOW_MIN' ? 'below minimum' : 'above maximum'} of ${formatTemp(reading.thresholdC)}`
            : 'Within agreed range',
        ],
      }))
    );
  }

  #alertSection(layout, report) {
    const alerts = report.temperature.alerts;
    layout.sectionHeading('8. Alerts and exceptions');

    if (alerts.length === 0) {
      layout.note('No temperature alerts were raised for this shipment.');
      return;
    }

    layout.note(
      'Each alert below was recorded as a permanent entry at the moment the reading breached the agreed range. Alerts are never edited or cleared - this is what allows the exact time of a temperature excursion to be established after the fact.'
    );

    layout.table(
      [
        { label: 'Record no.', width: 60 },
        { label: 'Occurred at (UTC)', width: 150 },
        { label: 'Reading', width: 70 },
        { label: 'Breach', width: 100 },
        { label: 'Origin', width: 119 },
      ],
      alerts.map((alert) => ({
        tone: PALETTE.alert,
        cells: [
          String(alert.version),
          formatInstant(alert.at),
          formatTemp(alert.temperatureC),
          `${alert.direction === 'BELOW_MIN' ? 'Below' : 'Above'} ${formatTemp(alert.thresholdC)}`,
          alert.sourceLabel,
        ],
      }))
    );
  }

  #historySection(layout, report) {
    layout.sectionHeading('9. Complete historical record');
    layout.note(
      'Every entry in chronological order, exactly as recorded. Record numbers are sequential and gap-free; a missing number would itself be evidence of tampering.'
    );

    layout.table(
      [
        { label: 'No.', width: 32 },
        { label: 'What happened', width: 120 },
        { label: 'When (UTC)', width: 120 },
        { label: 'Details', width: 227 },
      ],
      report.history.map((entry) => ({
        tone: entry.isAlert ? PALETTE.alert : PALETTE.ink,
        cells: [String(entry.version), entry.label, formatInstant(entry.at), entry.summary],
      }))
    );
  }

  #integritySection(layout, report) {
    layout.sectionHeading('10. Verification statement');

    if (report.integrity.intact) {
      layout.paragraph(
        `Each record in this history carries a cryptographic fingerprint derived from its own contents and from the fingerprint of the record before it. All ${report.integrity.eventCount} records were re-checked when this report was produced, and the chain verified intact: true.`
      );
      layout.paragraph(
        'Altering or removing any record would break every fingerprint after it, and that break would be detected by this same check.'
      );
    } else {
      layout.paragraph(
        `This history did NOT verify. Integrity intact: false. ${report.integrity.issues.length} issue(s) were detected, listed below. The record should not be relied upon as evidence until the cause has been established.`
      );
      for (const issue of report.integrity.issues.slice(0, 20)) {
        layout.bullet(`${issue.type} at record ${issue.version ?? '-'}: ${issue.message ?? ''}`);
      }
    }

    layout.fieldGrid([
      ['Verification result', report.integrity.intact ? 'Intact' : 'COMPROMISED'],
      ['Records verified', String(report.integrity.eventCount)],
      ['Checked at', formatInstant(report.integrity.verifiedAt)],
      ['Chain fingerprint', report.integrity.headHash ? `${report.integrity.headHash.slice(0, 24)}...` : '-'],
    ]);
  }
}

/**
 * Small layout helper.
 *
 * PDFKit is a drawing API with a cursor, not a document model, so without
 * something like this every section grows its own slightly different spacing
 * and page-break handling - and the page breaks are what actually matter here,
 * because a shipment with three hundred readings must not run off the bottom of
 * page one.
 */
class PdfLayout {
  constructor(doc) {
    this.doc = doc;
    this.contentWidth = doc.page.width - PAGE_MARGIN * 2;
  }

  get bottomLimit() {
    return this.doc.page.height - PAGE_MARGIN - 28;
  }

  ensureSpace(height) {
    if (this.doc.y + height > this.bottomLimit) this.doc.addPage();
  }

  sectionHeading(text) {
    this.ensureSpace(56);
    this.doc.moveDown(0.7);
    this.doc.font('Helvetica-Bold').fontSize(12).fillColor(PALETTE.accent).text(text);
    const y = this.doc.y + 2;
    this.doc
      .moveTo(PAGE_MARGIN, y)
      .lineTo(PAGE_MARGIN + this.contentWidth, y)
      .lineWidth(0.8)
      .strokeColor(PALETTE.hairline)
      .stroke();
    this.doc.moveDown(0.5);
  }

  subHeading(text) {
    this.ensureSpace(34);
    this.doc.moveDown(0.35);
    this.doc.font('Helvetica-Bold').fontSize(9.5).fillColor(PALETTE.ink).text(text);
    this.doc.moveDown(0.2);
  }

  paragraph(text) {
    this.ensureSpace(46);
    this.doc.font('Helvetica').fontSize(9.5).fillColor(PALETTE.ink).text(text, { width: this.contentWidth });
    this.doc.moveDown(0.35);
  }

  note(text) {
    this.ensureSpace(38);
    this.doc
      .font('Helvetica-Oblique')
      .fontSize(8.5)
      .fillColor(PALETTE.muted)
      .text(text, { width: this.contentWidth });
    this.doc.moveDown(0.4);
  }

  bullet(text) {
    this.ensureSpace(24);
    this.doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(PALETTE.ink)
      .text(`-  ${text}`, { width: this.contentWidth - 10, indent: 6 });
  }

  calloutBox(tone, title, body) {
    this.ensureSpace(66);
    const top = this.doc.y;
    const height = 46;

    this.doc.save();
    this.doc.rect(PAGE_MARGIN, top, this.contentWidth, height).fill(PALETTE.panel);
    this.doc.rect(PAGE_MARGIN, top, 3.2, height).fill(tone);
    this.doc.restore();

    this.doc
      .font('Helvetica-Bold')
      .fontSize(9.5)
      .fillColor(tone)
      .text(title, PAGE_MARGIN + 12, top + 8, { width: this.contentWidth - 24 });
    this.doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(PALETTE.ink)
      .text(body, PAGE_MARGIN + 12, this.doc.y + 1, { width: this.contentWidth - 24 });

    this.doc.y = top + height + 8;
    this.doc.x = PAGE_MARGIN;
  }

  /** Two-column label/value grid. */
  fieldGrid(pairs) {
    const columnWidth = this.contentWidth / 2;
    const rowHeight = 26;

    for (let index = 0; index < pairs.length; index += 2) {
      this.ensureSpace(rowHeight + 6);
      const top = this.doc.y;

      [pairs[index], pairs[index + 1]].forEach((pair, column) => {
        if (!pair) return;
        const x = PAGE_MARGIN + column * columnWidth;
        this.doc
          .font('Helvetica')
          .fontSize(7.5)
          .fillColor(PALETTE.muted)
          .text(String(pair[0]).toUpperCase(), x, top, { width: columnWidth - 14 });
        this.doc
          .font('Helvetica-Bold')
          .fontSize(9.5)
          .fillColor(PALETTE.ink)
          .text(
            pair[1] === null || pair[1] === undefined || pair[1] === '' ? '-' : String(pair[1]),
            x,
            top + 10,
            { width: columnWidth - 14 }
          );
      });

      this.doc.y = top + rowHeight;
      this.doc.x = PAGE_MARGIN;
    }
    this.doc.moveDown(0.3);
  }

  /**
   * A table that repeats its header after a page break.
   *
   * Row height is measured from the tallest wrapped cell rather than assumed,
   * because an event summary can be a full sentence and a fixed row height
   * would silently clip it - losing exactly the detail the report exists to
   * carry.
   */
  table(columns, rows) {
    const drawHeader = () => {
      const top = this.doc.y;
      this.doc.save();
      this.doc.rect(PAGE_MARGIN, top - 2, this.contentWidth, 16).fill(PALETTE.panel);
      this.doc.restore();

      let x = PAGE_MARGIN;
      for (const column of columns) {
        this.doc
          .font('Helvetica-Bold')
          .fontSize(7.5)
          .fillColor(PALETTE.muted)
          .text(column.label.toUpperCase(), x + 4, top + 2, { width: column.width - 8 });
        x += column.width;
      }
      this.doc.y = top + 18;
      this.doc.x = PAGE_MARGIN;
    };

    this.ensureSpace(60);
    drawHeader();

    for (const row of rows) {
      const heights = columns.map((column, index) =>
        this.doc
          .font('Helvetica')
          .fontSize(8.5)
          .heightOfString(String(row.cells[index] ?? ''), { width: column.width - 8 })
      );
      const rowHeight = Math.max(...heights) + 7;

      if (this.doc.y + rowHeight > this.bottomLimit) {
        this.doc.addPage();
        drawHeader();
      }

      const top = this.doc.y;
      let x = PAGE_MARGIN;
      for (const [index, column] of columns.entries()) {
        this.doc
          .font(index === 0 ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(8.5)
          .fillColor(row.tone ?? PALETTE.ink)
          .text(String(row.cells[index] ?? ''), x + 4, top + 1, { width: column.width - 8 });
        x += column.width;
      }

      this.doc.y = top + rowHeight;
      this.doc.x = PAGE_MARGIN;
      this.doc
        .moveTo(PAGE_MARGIN, this.doc.y - 3)
        .lineTo(PAGE_MARGIN + this.contentWidth, this.doc.y - 3)
        .lineWidth(0.4)
        .strokeColor(PALETTE.hairline)
        .stroke();
    }
    this.doc.moveDown(0.4);
  }

  /** Footer on every page, added last so the total page count is known. */
  paginate(report) {
    const range = this.doc.bufferedPageRange();
    for (let index = 0; index < range.count; index += 1) {
      this.doc.switchToPage(range.start + index);
      const y = this.doc.page.height - PAGE_MARGIN + 6;

      this.doc
        .moveTo(PAGE_MARGIN, y - 6)
        .lineTo(this.doc.page.width - PAGE_MARGIN, y - 6)
        .lineWidth(0.4)
        .strokeColor(PALETTE.hairline)
        .stroke();

      this.doc
        .font('Helvetica')
        .fontSize(7.5)
        .fillColor(PALETTE.muted)
        .text(
          `Shipment ${report.identification.shipmentId}  -  Generated ${formatInstant(report.generatedAt)}  -  ${
            report.integrity.intact ? 'Record verified intact' : 'RECORD INTEGRITY COMPROMISED'
          }`,
          PAGE_MARGIN,
          y,
          { width: this.contentWidth - 60, lineBreak: false }
        );

      this.doc.text(`Page ${index + 1} of ${range.count}`, this.doc.page.width - PAGE_MARGIN - 60, y, {
        width: 60,
        align: 'right',
        lineBreak: false,
      });
    }
  }
}

const humanise = (key) =>
  key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (char) => char.toUpperCase())
    .trim();
