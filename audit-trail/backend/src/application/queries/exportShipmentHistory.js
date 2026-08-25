import PDFDocument from 'pdfkit';
import { validateShipmentId } from '../../domain/shipment/validators/commandValidators.js';
import { AggregateNotFoundError } from '../../shared/errors/AppError.js';

/**
 * Export Shipment History Query Handler
 * Generates CSV or PDF containing the full event history and payload diffs of a shipment.
 */
export class ExportShipmentHistoryQueryHandler {
  #replayService;
  #eventStore;

  constructor({ replayService, eventStore }) {
    this.#replayService = replayService;
    this.#eventStore = eventStore;
  }

  async handle({ shipmentId, format, res }) {
    validateShipmentId(shipmentId);

    let steps;
    try {
      steps = await this.#replayService.reconstructStepByStep(shipmentId);
    } catch (error) {
      if (error instanceof AggregateNotFoundError) {
        res.status(404).json({ error: { code: 'AGGREGATE_NOT_FOUND', message: `Shipment ${shipmentId} not found.` } });
        return;
      }
      throw error;
    }

    const integrityResult = await this.#eventStore.verifyChain(shipmentId);
    const integrityMessage = integrityResult.intact
      ? `Hash chain verified intact: true as of ${new Date().toISOString()}`
      : 'WARNING: Hash chain tampered. Integrity intact: false';

    if (format === 'csv') {
      this._generateCSV(shipmentId, steps, integrityMessage, res);
    } else if (format === 'pdf') {
      this._generatePDF(shipmentId, steps, integrityMessage, res);
    } else {
      res.status(400).json({ error: { code: 'INVALID_FORMAT', message: 'Format must be csv or pdf.' } });
    }
  }

  _diffPayload(state) {
    if (!state) return '';
    return Object.entries(state)
      .filter(([k, v]) => k !== 'id' && v !== null && v !== undefined && v !== '')
      .map(([k, v]) => {
        if (Array.isArray(v)) return `${k}: [${v.length} items]`;
        if (typeof v === 'object') return `${k}: {...}`;
        return `${k}: ${v}`;
      }).join(', ');
  }

  _generateCSV(shipmentId, steps, integrityMessage, res) {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${shipmentId}-history.csv"`);

    // Write BOM for Excel
    res.write('\ufeff');
    res.write('"Version","Event Type","Timestamp","Actor","Payload Summary"\n');

    let previousState = {};

    for (const step of steps) {
      const actor = step.stateAfter?.updatedBy ?? 'System';
      // Compute simplistic diff summary for actual changes
      let summaryParts = [];
      const currentRelevantState = { ...step.stateAfter };
      delete currentRelevantState.id;
      delete currentRelevantState.updatedBy;

      for (const [key, val] of Object.entries(currentRelevantState)) {
        if (key === 'history' || key === 'alerts' || key === 'readings') continue; // Skip complex lists for flat summary
        if (JSON.stringify(val) !== JSON.stringify(previousState[key])) {
          summaryParts.push(`${key}: ${JSON.stringify(previousState[key] ?? null)} \u2192 ${JSON.stringify(val)}`);
        }
      }

      const payloadSummary = summaryParts.length > 0 ? summaryParts.join(' | ') : 'No scalar changes';

      const row = [
        step.version,
        step.eventType,
        step.timestamp,
        actor,
        payloadSummary
      ].map(field => {
        const text = String(field);
        if (text.includes('"') || text.includes(',') || text.includes('\n')) {
          return `"${text.replace(/"/g, '""')}"`;
        }
        return text;
      });

      res.write(row.join(',') + '\n');
      previousState = currentRelevantState;
    }

    res.write('\n');
    res.write(`"Integrity Statement","${integrityMessage.replace(/"/g, '""')}"\n`);

    res.end();
  }

  _generatePDF(shipmentId, steps, integrityMessage, res) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${shipmentId}-history.pdf"`);

    const doc = new PDFDocument({ margin: 50 });
    doc.pipe(res);

    doc.fontSize(20).text(`Shipment History: ${shipmentId}`, { align: 'center' });
    doc.moveDown();

    doc.fontSize(10).fillColor(integrityMessage.includes('intact: false') ? 'red' : 'green')
      .text(integrityMessage, { align: 'center' });
    doc.moveDown();
    doc.fillColor('black');

    let previousState = {};

    for (const step of steps) {
      doc.fontSize(12).font('Helvetica-Bold').text(`v${step.version} - ${step.eventType} at ${step.timestamp}`);

      const actor = step.stateAfter?.updatedBy ?? 'System';
      doc.fontSize(10).font('Helvetica').text(`Actor: ${actor}`);

      let summaryParts = [];
      const currentRelevantState = { ...step.stateAfter };
      delete currentRelevantState.id;
      delete currentRelevantState.updatedBy;

      for (const [key, val] of Object.entries(currentRelevantState)) {
        if (key === 'history' || key === 'alerts' || key === 'readings') continue;
        if (JSON.stringify(val) !== JSON.stringify(previousState[key])) {
          summaryParts.push(`${key}: ${JSON.stringify(previousState[key] ?? null)} \u2192 ${JSON.stringify(val)}`);
        }
      }

      const payloadSummary = summaryParts.length > 0 ? summaryParts.join(' | ') : 'No scalar changes';
      doc.fontSize(10).text(`Changes: ${payloadSummary}`, { indent: 20 });
      doc.moveDown(0.5);

      previousState = currentRelevantState;
    }

    doc.end();
  }
}
