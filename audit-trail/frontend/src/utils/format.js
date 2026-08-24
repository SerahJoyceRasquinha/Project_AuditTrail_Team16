/**
 * Presentation helpers.
 *
 * Timestamps arrive as UTC ISO strings and are displayed in the viewer's local
 * timezone *with the zone shown*. Roadmap 12.9 requires that policy to be
 * decided rather than left implicit: storing UTC and rendering local is the
 * decision, and the visible zone label is what stops a dispute about "when did
 * the temperature spike" from turning into an argument about timezones.
 */

const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export const localZone = LOCAL_ZONE;

export function formatTimestamp(iso, { withZone = true, seconds = true } = {}) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Invalid date';

  const formatted = date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
    hour12: false,
  });

  return withZone ? `${formatted} (${LOCAL_ZONE})` : formatted;
}

export function formatShortTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function formatRelative(iso) {
  if (!iso) return '—';
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs)) return '—';

  const minutes = Math.round(diffMs / 60000);
  if (Math.abs(minutes) < 1) return 'just now';
  if (Math.abs(minutes) < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function formatTemperature(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${Number(value).toFixed(1)} °C`;
}

/** Human labels for the raw event type constants. */
export const EVENT_LABELS = {
  CONTAINER_CREATED: 'Container created',
  LOADED_ON_SHIP: 'Loaded on ship',
  TEMPERATURE_RECORDED: 'Temperature recorded',
  TEMPERATURE_SPIKE: 'Temperature spike',
  ARRIVED_AT_PORT: 'Arrived at port',
  UNLOADED_FROM_SHIP: 'Unloaded from ship',
  SHIPMENT_DETAILS_AMENDED: 'Details amended',
  SHIPMENT_ARCHIVED: 'Shipment archived',
  SHIPMENT_RESTORED: 'Shipment restored',
};

export const eventLabel = (eventType) => EVENT_LABELS[eventType] ?? eventType;

export const STATE_LABELS = {
  CREATED: 'Created',
  IN_TRANSIT: 'In transit',
  AT_PORT: 'At port',
  UNLOADED: 'Unloaded',
};

export const stateLabel = (state) => STATE_LABELS[state] ?? state ?? '—';

/** Maps an event type to a CSS modifier used for its timeline dot and badge. */
export function eventTone(eventType) {
  switch (eventType) {
    case 'TEMPERATURE_SPIKE':
      return 'danger';
    case 'CONTAINER_CREATED':
      return 'neutral';
    case 'ARRIVED_AT_PORT':
    case 'UNLOADED_FROM_SHIP':
      return 'success';
    case 'TEMPERATURE_RECORDED':
      return 'muted';
    case 'SHIPMENT_DETAILS_AMENDED':
      return 'violet';
    case 'SHIPMENT_ARCHIVED':
      return 'muted';
    case 'SHIPMENT_RESTORED':
      return 'success';
    default:
      return 'accent';
  }
}

/** Renders an event payload as ordered label/value pairs for the event card. */
export function payloadEntries(payload = {}) {
  const labels = {
    containerCode: 'Container code',
    origin: 'Origin',
    destination: 'Destination',
    cargoDescription: 'Cargo',
    carrier: 'Carrier',
    minTemperatureC: 'Min temperature',
    maxTemperatureC: 'Max temperature',
    location: 'Location',
    vesselName: 'Vessel',
    voyageNumber: 'Voyage',
    portName: 'Port',
    berth: 'Berth',
    temperatureC: 'Temperature',
    recordedAt: 'Sampled at',
    sensorId: 'Sensor',
    thresholdC: 'Threshold breached',
    direction: 'Direction',
    notes: 'Notes',
    yardBlock: 'Yard block',
    reason: 'Reason',
  };

  return Object.entries(payload).map(([key, value]) => {
    let display = value;
    if (key === 'temperatureC' || key === 'thresholdC' || key === 'minTemperatureC' || key === 'maxTemperatureC') {
      display = formatTemperature(value);
    } else if (key === 'recordedAt') {
      display = formatTimestamp(value);
    } else if (value === null || value === undefined || value === '') {
      display = '—';
    }
    return { key, label: labels[key] ?? key, value: String(display) };
  });
}

export const truncateHash = (hash) => (hash ? `${hash.slice(0, 12)}…${hash.slice(-4)}` : '—');
