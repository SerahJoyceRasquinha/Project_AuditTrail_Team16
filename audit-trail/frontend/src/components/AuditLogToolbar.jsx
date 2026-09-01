import { useEffect, useRef } from 'react';

export function filterAuditEvents(events = [], search = '', eventType = 'ALL', breachOnly = false) {
  const query = search.trim().toLowerCase();

  return events.filter((event) => {
    const matchesSearch =
      !query ||
      event.eventId.toLowerCase().includes(query) ||
      event.eventType.toLowerCase().includes(query) ||
      (event.shipmentId ?? '').toLowerCase().includes(query) ||
      JSON.stringify(event.payload ?? {}).toLowerCase().includes(query);

    const matchesType = eventType === 'ALL' || event.eventType === eventType;
    const matchesBreach = !breachOnly || event.eventType === 'TEMPERATURE_SPIKE';

    return matchesSearch && matchesType && matchesBreach;
  });
}

/**
 * Toolbar for filtering the immutable event ledger.
 *
 * Keyboard shortcut: pressing "/" or Ctrl+F when focus is outside a text
 * input jumps to the search field — useful during demos.
 */
export function AuditLogToolbar({
  value,
  onChange,
  eventType,
  onTypeChange,
  breachOnly,
  onBreachOnlyChange,
  totalCount = 0,
  filteredCount = 0,
}) {
  const inputRef = useRef(null);
  const isFiltering = value.trim() !== '' || eventType !== 'ALL' || breachOnly;
  const showCount = isFiltering;

  /* Focus the search box when the user presses "/" or Ctrl+F */
  useEffect(() => {
    function handleKeyDown(e) {
      const tag = document.activeElement?.tagName ?? '';
      const isInInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      if (isInInput) return;

      if (e.key === '/' || (e.ctrlKey && e.key === 'f')) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="audit-log-toolbar">
      <label className="field audit-log-toolbar__search">
        <span className="field__label">
          Search events
          <kbd className="audit-search-hint" title="Press / or Ctrl+F to focus">/</kbd>
        </span>
        <div className="audit-search-wrap">
          <input
            ref={inputRef}
            className="input audit-search-input"
            type="search"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Shipment ID, event name, sensor, location…"
            aria-label="Search audit events"
          />
          {value && (
            <button
              type="button"
              className="audit-search-clear"
              onClick={() => {
                onChange('');
                inputRef.current?.focus();
              }}
              aria-label="Clear search"
            >
              ✕
            </button>
          )}
        </div>
      </label>

      <label className="field audit-log-toolbar__type">
        <span className="field__label">Event type</span>
        <select
          className="select"
          value={eventType}
          onChange={(e) => onTypeChange(e.target.value)}
          aria-label="Filter by event type"
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

      {showCount && (
        <div className="audit-log-toolbar__count" aria-live="polite">
          <span className={filteredCount === 0 ? 'audit-count audit-count--empty' : 'audit-count'}>
            {filteredCount === 0
              ? 'No matches'
              : filteredCount === totalCount
                ? `${totalCount} events`
                : `${filteredCount} of ${totalCount}`}
          </span>
          {isFiltering && (
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => {
                onChange('');
                onTypeChange('ALL');
                onBreachOnlyChange(false);
              }}
              aria-label="Clear all filters"
            >
              Clear filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}
