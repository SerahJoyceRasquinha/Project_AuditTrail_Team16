import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useDebouncedValue, useShipmentList } from '../hooks/useShipmentData.js';
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../components/StatusBlocks.jsx';
import { formatRelative, formatTemperature, stateLabel } from '../utils/format.js';

/**
 * The dashboard (roadmap 9.7, Week 1).
 *
 * The search bar is the entry point the source document names: look up a
 * specific shipment ID. The list below it exists so the tool is usable before
 * you know which ID you are investigating.
 */
export function DashboardPage() {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({
    state: '',
    origin: '',
    destination: '',
    hasBreach: '',
    minTemperature: '',
    maxTemperature: '',
    lastEventFrom: '',
    lastEventTo: '',
  });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const debouncedSearch = useDebouncedValue(search, 250);
  const hasFilters = Object.values(filters).some(Boolean);

  const { data, status, error, refetch, isLoading } = useShipmentList({
    search: debouncedSearch || undefined,
    page,
    pageSize: 12,
    ...filters,
  });

  const shipments = data?.items ?? [];
  const pagination = data?.pagination;

  function updateFilter(name, value) {
    setFilters((current) => ({ ...current, [name]: value }));
    setPage(1);
  }

  function clearFilters() {
    setFilters({
      state: '',
      origin: '',
      destination: '',
      hasBreach: '',
      minTemperature: '',
      maxTemperature: '',
      lastEventFrom: '',
      lastEventTo: '',
    });
    setPage(1);
  }

  return (
    <>
      <div className="search">
        <input
          className="input search__input"
          value={search}
          onChange={(bubble) => {
            setSearch(bubble.target.value);
            setPage(1);
          }}
          placeholder="Search by shipment ID or container code — e.g. SHP-1001"
          aria-label="Search shipments"
          spellCheck={false}
        />
        <button type="button" className="btn" onClick={refetch}>
          Refresh
        </button>
      </div>

      <div className="filter-panel">
        <div className="filter-panel__head">
          <button
            type="button"
            className="btn btn--ghost filter-panel__toggle"
            onClick={() => setFiltersOpen((open) => !open)}
            aria-expanded={filtersOpen}
          >
            <span aria-hidden="true">{filtersOpen ? '−' : '+'}</span>
            Filters {hasFilters ? `· ${Object.values(filters).filter(Boolean).length} active` : ''}
          </button>
          {hasFilters ? (
            <button type="button" className="btn btn--sm btn--ghost" onClick={clearFilters}>
              Clear all
            </button>
          ) : null}
        </div>

        {filtersOpen ? (
          <div className="filter-panel__body">
            <label className="field">
              <span className="field__label">Lifecycle status</span>
              <select className="select" value={filters.state} onChange={(event) => updateFilter('state', event.target.value)}>
                <option value="">Any status</option>
                <option value="CREATED">Created</option>
                <option value="IN_TRANSIT">In transit</option>
                <option value="AT_PORT">At port</option>
                <option value="UNLOADED">Unloaded</option>
              </select>
            </label>
            <label className="field">
              <span className="field__label">Origin</span>
              <input className="input" value={filters.origin} onChange={(event) => updateFilter('origin', event.target.value)} placeholder="e.g. Chennai" />
            </label>
            <label className="field">
              <span className="field__label">Destination</span>
              <input className="input" value={filters.destination} onChange={(event) => updateFilter('destination', event.target.value)} placeholder="e.g. Rotterdam" />
            </label>
            <label className="field">
              <span className="field__label">Temperature breaches</span>
              <select className="select" value={filters.hasBreach} onChange={(event) => updateFilter('hasBreach', event.target.value)}>
                <option value="">Any reading</option>
                <option value="true">Breaches only</option>
                <option value="false">No breaches</option>
              </select>
            </label>
            <label className="field">
              <span className="field__label">Latest temperature, min °C</span>
              <input className="input" type="number" value={filters.minTemperature} onChange={(event) => updateFilter('minTemperature', event.target.value)} placeholder="e.g. -10" />
            </label>
            <label className="field">
              <span className="field__label">Latest temperature, max °C</span>
              <input className="input" type="number" value={filters.maxTemperature} onChange={(event) => updateFilter('maxTemperature', event.target.value)} placeholder="e.g. 8" />
            </label>
            <label className="field">
              <span className="field__label">Last event after</span>
              <input className="input" type="date" value={filters.lastEventFrom} onChange={(event) => updateFilter('lastEventFrom', event.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">Last event before</span>
              <input className="input" type="date" value={filters.lastEventTo} onChange={(event) => updateFilter('lastEventTo', event.target.value)} />
            </label>
          </div>
        ) : null}
      </div>

      {isLoading && shipments.length === 0 ? (
        <div className="panel">
          <LoadingBlock label="Loading shipments" lines={4} />
        </div>
      ) : null}

      {status === 'error' ? (
        <div className="panel">
          <ErrorBlock error={error} onRetry={refetch} />
        </div>
      ) : null}

      {status === 'success' && shipments.length === 0 ? (
        <div className="panel">
          <EmptyBlock
            title={debouncedSearch || hasFilters ? 'No shipment matches these filters' : 'The ledger is empty'}
            message={
              debouncedSearch || hasFilters
                ? 'Adjust the search or filters, or clear them to see more of the ledger.'
                : 'Run `npm run seed:http` in the backend to load the demonstration shipments. It works whether you are running against MongoDB or in memory.'
            }
          />
        </div>
      ) : null}

      {shipments.length > 0 ? (
        <>
          <div className="shipment-grid">
            {shipments.map((shipment) => (
              <Link
                key={shipment.aggregateId}
                to={`/shipment/${encodeURIComponent(shipment.aggregateId)}`}
                className={`shipment-card ${shipment.temperatureExcursion ? 'shipment-card--breach' : ''}`}
              >
                <div className="shipment-card__id">{shipment.aggregateId}</div>
                <div className="shipment-card__route">
                  {shipment.origin} → {shipment.destination}
                </div>
                <div className="shipment-card__meta">
                  <span className="pill pill--teal">
                    <span className="pill__dot" />
                    {stateLabel(shipment.currentState)}
                  </span>
                  <span className="pill">v{shipment.currentVersion}</span>
                  {shipment.temperatureExcursion ? (
                    <span className="pill pill--amber">
                      <span className="pill__dot" />
                      {shipment.temperatureBreachCount} breach
                      {shipment.temperatureBreachCount === 1 ? '' : 'es'}
                    </span>
                  ) : null}
                </div>
                <div className="eyebrow" style={{ marginTop: 10 }}>
                  {formatTemperature(shipment.latestTemperatureC)} · updated {formatRelative(shipment.lastEventAt)}
                </div>
              </Link>
            ))}
          </div>

          {pagination && pagination.totalPages > 1 ? (
            <div className="pagination">
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setPage((current) => Math.max(current - 1, 1))}
                disabled={pagination.page <= 1}
              >
                Previous
              </button>
              <span className="mono">
                Page {pagination.page} of {pagination.totalPages} · {pagination.total} shipments
              </span>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setPage((current) => Math.min(current + 1, pagination.totalPages))}
                disabled={pagination.page >= pagination.totalPages}
              >
                Next
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}
