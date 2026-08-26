function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function safeShipmentId(shipmentId) {
  return String(shipmentId).replace(/[^a-z0-9_-]+/gi, '_');
}

function csvValue(value) {
  const text = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

export function eventsToCsv(events) {
  const headers = ['eventId', 'aggregateId', 'eventType', 'version', 'timestamp', 'payload', 'previousHash', 'hash'];
  const rows = events.map((event) =>
    [
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.version,
      event.timestamp,
      event.payload,
      event.previousHash,
      event.hash,
    ]
      .map(csvValue)
      .join(',')
  );
  return [headers.join(','), ...rows].join('\n');
}

export function downloadAuditHistory(shipmentId, events, format) {
  const baseName = `audit-history-${safeShipmentId(shipmentId)}`;
  if (format === 'csv') {
    downloadFile(eventsToCsv(events), `${baseName}.csv`, 'text/csv;charset=utf-8');
    return;
  }

  downloadFile(JSON.stringify({ shipmentId, exportedAt: new Date().toISOString(), events }, null, 2), `${baseName}.json`, 'application/json');
}