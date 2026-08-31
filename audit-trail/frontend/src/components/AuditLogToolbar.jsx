export function filterAuditEvents(events = [], search = '', eventType = 'ALL', breachOnly = false) {
  const query = search.trim().toLowerCase();

  return events.filter((event) => {
    const matchesSearch =
      !query ||
      event.eventId.toLowerCase().includes(query) ||
      event.eventType.toLowerCase().includes(query) ||
      JSON.stringify(event.payload ?? {}).toLowerCase().includes(query);

    const matchesType = eventType === 'ALL' || event.eventType === eventType;
    const matchesBreach = !breachOnly || event.eventType === 'TEMPERATURE_SPIKE';

    return matchesSearch && matchesType && matchesBreach;
  });
}

export function AuditLogToolbar({ value, onChange, eventType, onTypeChange, breachOnly, onBreachOnlyChange }) {
  return (
    <div className="audit-log-toolbar">
      <label className="field audit-log-toolbar__search">
        <span className="field__label">Search audit log</span>
        <input
          className="input"
          type="search"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Search audit log"
          aria-label="Search audit log"
        />
      </label>

      <label className="field audit-log-toolbar__type">
        <span className="field__label">Event type</span>
        <select
          className="select"
          value={eventType}
          onChange={(event) => onTypeChange(event.target.value)}
          aria-label="Event type"
        >
          <option value="ALL">All events</option>
          <option value="CONTAINER_CREATED">Container created</option>
          <option value="LOADED_ON_SHIP">Loaded on ship</option>
          <option value="TEMPERATURE_RECORDED">Temperature recorded</option>
          <option value="TEMPERATURE_SPIKE">Temperature spike</option>
          <option value="ARRIVED_AT_PORT">Arrived at port</option>
          <option value="UNLOADED_FROM_SHIP">Unloaded from ship</option>
          <option value="SHIPMENT_DETAILS_AMENDED">Details amended</option>
          <option value="SHIPMENT_ARCHIVED">Shipment archived</option>
          <option value="SHIPMENT_RESTORED">Shipment restored</option>
          <option value="SHIPMENT_SCHEDULE_PLANNED">Schedule agreed</option>
          <option value="SHIPMENT_SCHEDULE_REVISED">Schedule revised</option>
          <option value="SHIPMENT_SCHEDULE_EXTENDED">Delay recorded</option>
        </select>
      </label>

      <label className="field audit-log-toolbar__toggle">
        <span className="field__label">Breach only</span>
        <button
          type="button"
          className={`btn btn--sm ${breachOnly ? 'btn--primary' : 'btn--ghost'}`}
          onClick={() => onBreachOnlyChange(!breachOnly)}
          aria-pressed={breachOnly}
        >
          {breachOnly ? 'On' : 'Off'}
        </button>
      </label>
    </div>
  );
}
