import { useEffect, useMemo, useRef } from 'react';
import { eventLabel } from '../utils/format.js';

export function filterAuditEvents(events = [], search = '', eventType = 'ALL', breachOnly = false, fromDate = '', toDate = '') {
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

    let matchesFromDate = true;
    if (fromDate) {
      matchesFromDate = event.timestamp >= fromDate;
    }

    let matchesToDate = true;
    if (toDate) {
      matchesToDate = event.timestamp <= `${toDate}T23:59:59.999Z`;
    }

    return matchesSearch && matchesType && matchesBreach && matchesFromDate && matchesToDate;
  });
}

/**
 * Toolbar for filtering the immutable event ledger.
 *
 * Keyboard shortcut: pressing "/" or Ctrl+F when focus is outside a text
 * input jumps to the search field — useful during demos.
 */
export function AuditLogToolbar({
  events = [],
  value,
  onChange,
  eventType,
  onTypeChange,
  breachOnly,
  onBreachOnlyChange,
  fromDate,
  onFromDateChange,
  toDate,
  onToDateChange,
  totalCount = 0,
  filteredCount = 0,
}) {
  const inputRef = useRef(null);
  const isFiltering = value.trim() !== '' || eventType !== 'ALL' || breachOnly || fromDate !== '' || toDate !== '';
  const showCount = isFiltering;

  const availableTypes = useMemo(() => {
    const types = new Set(events.map((e) => e.eventType));
    return Array.from(types).sort();
  }, [events]);

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
            placeholder="Search audit log — shipment ID, event name, sensor, location…"
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
          {availableTypes.map((type) => (
            <option key={type} value={type}>
              {eventLabel(type)}
            </option>
          ))}
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

      <label className="field audit-log-toolbar__date">
        <span className="field__label">From Date</span>
        <input
          type="date"
          className="input input--calendar-white"
          value={fromDate}
          onChange={(e) => onFromDateChange(e.target.value)}
          aria-label="Filter from date"
        />
      </label>

      <label className="field audit-log-toolbar__date">
        <span className="field__label">To Date</span>
        <input
          type="date"
          className="input input--calendar-white"
          value={toDate}
          onChange={(e) => onToDateChange(e.target.value)}
          aria-label="Filter to date"
          min={fromDate || undefined}
        />
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
                if (onFromDateChange) onFromDateChange('');
                if (onToDateChange) onToDateChange('');
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
