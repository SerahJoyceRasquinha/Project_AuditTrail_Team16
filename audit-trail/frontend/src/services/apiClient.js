/**
 * The single place the frontend talks to the backend.
 *
 * Two things it does that matter beyond wrapping fetch:
 *
 *  - it turns the backend's structured error envelope into a real `ApiError`
 *    carrying `code`, `status` and `details`, so components can branch on
 *    `error.code === 'CONCURRENCY_CONFLICT'` rather than matching on message
 *    text;
 *  - every call accepts an `AbortSignal`, which is what keeps the time scrubber
 *    from rendering the results of a request the user has already scrubbed past.
 */

const BASE_URL = import.meta.env?.VITE_API_BASE_URL ?? '';

export class ApiError extends Error {
  constructor(message, { status, code, details, correlationId } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status ?? 0;
    this.code = code ?? 'NETWORK_ERROR';
    this.details = details ?? null;
    this.correlationId = correlationId ?? null;
  }

  get isConflict() {
    return this.code === 'CONCURRENCY_CONFLICT';
  }

  get isNotFound() {
    return this.code === 'AGGREGATE_NOT_FOUND' || this.status === 404;
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    // An aborted request is a normal part of the scrubber's life, not a failure
    // to report to the user, so it is rethrown untouched for callers to ignore.
    if (error.name === 'AbortError') throw error;
    throw new ApiError('Could not reach the Audit Trail API. Is the backend running?', {
      status: 0,
      code: 'NETWORK_ERROR',
    });
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const envelope = payload?.error ?? {};
    throw new ApiError(envelope.message ?? `Request failed with status ${response.status}.`, {
      status: response.status,
      code: envelope.code,
      details: envelope.details,
      correlationId: payload?.correlationId ?? response.headers.get('x-correlation-id'),
    });
  }

  return payload;
}

// --- Queries (read side) ----------------------------------------------------

export const listShipments = (params = {}, signal) => {
  const query = new URLSearchParams();
  if (params.page) query.set('page', String(params.page));
  if (params.pageSize) query.set('pageSize', String(params.pageSize));
  if (params.state) query.set('state', params.state);
  if (params.search) query.set('search', params.search);
  if (params.origin) query.set('origin', params.origin);
  if (params.destination) query.set('destination', params.destination);
  if (params.hasBreach) query.set('hasBreach', params.hasBreach);
  if (params.minTemperature !== '') query.set('minTemperature', String(params.minTemperature));
  if (params.maxTemperature !== '') query.set('maxTemperature', String(params.maxTemperature));
  if (params.lastEventFrom) query.set('lastEventFrom', `${params.lastEventFrom}T00:00:00.000Z`);
  if (params.lastEventTo) query.set('lastEventTo', `${params.lastEventTo}T23:59:59.999Z`);
  // 'active' is the backend default, so it is only sent when the operator has
  // explicitly asked to see archived shipments.
  if (params.view && params.view !== 'active') query.set('view', params.view);
  const suffix = query.toString() ? `?${query}` : '';
  return request(`/api/shipments${suffix}`, { signal });
};

export const getShipment = (shipmentId, signal) =>
  request(`/api/shipment/${encodeURIComponent(shipmentId)}`, { signal });

export const getShipmentEvents = (shipmentId, signal) =>
  request(`/api/shipment/${encodeURIComponent(shipmentId)}/events`, { signal });

export const getHistoricalState = (shipmentId, at, signal) =>
  request(`/api/shipment/${encodeURIComponent(shipmentId)}/state?at=${encodeURIComponent(at)}`, { signal });

export const getSensorSeries = (shipmentId, at, signal) => {
  const suffix = at ? `?at=${encodeURIComponent(at)}` : '';
  return request(`/api/shipment/${encodeURIComponent(shipmentId)}/sensors${suffix}`, { signal });
};

export const getIntegrity = (shipmentId, signal) =>
  request(`/api/shipment/${encodeURIComponent(shipmentId)}/integrity`, { signal });

export const getReconciliation = (shipmentId, signal) =>
  request(`/api/shipment/${encodeURIComponent(shipmentId)}/reconciliation`, { signal });

export const getWorkerStatus = (signal) => request('/api/meta/worker', { signal });

export const getEventCatalog = (signal) => request('/api/meta/event-catalog', { signal });

// --- Commands (write side) --------------------------------------------------

export const createShipment = (command) =>
  request('/api/shipment/create', { method: 'POST', body: command });

export const moveShipment = (command) => request('/api/shipment/move', { method: 'POST', body: command });

export const recordTemperature = (command) =>
  request('/api/shipment/temperature', { method: 'POST', body: command });

/**
 * Lifecycle management.
 *
 * These are POSTs to command endpoints rather than PUT/DELETE on a resource,
 * because that is what they are: editing and removing a shipment append events
 * exactly like moving one does. Nothing here mutates a record in place, and
 * `archive` deletes nothing at all.
 */
export const amendShipment = (command) => request('/api/shipment/amend', { method: 'POST', body: command });

export const archiveShipment = (command) =>
  request('/api/shipment/archive', { method: 'POST', body: command });

export const restoreShipment = (command) =>
  request('/api/shipment/restore', { method: 'POST', body: command });

export const exportShipment = async (shipmentId, format, signal) => {
  const url = `${BASE_URL}/api/shipment/${encodeURIComponent(shipmentId)}/export?format=${encodeURIComponent(format)}`;
  const response = await fetch(url, { signal });
  if (!response.ok) {
    let envelope = {};
    try {
      const text = await response.text();
      envelope = JSON.parse(text).error || {};
    } catch {
      // Ignored
    }
    throw new ApiError(envelope.message ?? `Request failed with status ${response.status}.`, {
      status: response.status,
      code: envelope.code,
      details: envelope.details,
    });
  }

  const blob = await response.blob();
  const downloadUrl = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.style.display = 'none';
  a.href = downloadUrl;

  // Extract filename from header if possible, else fallback
  const disposition = response.headers.get('content-disposition');
  let filename = `${shipmentId}-history.${format}`;
  if (disposition && disposition.indexOf('filename=') !== -1) {
    const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/;
    const matches = filenameRegex.exec(disposition);
    if (matches != null && matches[1]) {
      filename = matches[1].replace(/['"]/g, '');
    }
  }
  a.download = filename;

  document.body.appendChild(a);
  a.click();

  window.URL.revokeObjectURL(downloadUrl);
  a.remove();
};
