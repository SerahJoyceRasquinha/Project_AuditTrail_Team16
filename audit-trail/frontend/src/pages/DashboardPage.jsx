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
  const debouncedSearch = useDebouncedValue(search, 250);

  const { data, status, error, refetch, isLoading } = useShipmentList({
    search: debouncedSearch || undefined,
    page,
    pageSize: 12,
  });

  const shipments = data?.items ?? [];
  const pagination = data?.pagination;

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
            title={debouncedSearch ? 'No shipment matches that search' : 'The ledger is empty'}
            message={
              debouncedSearch
                ? 'Check the shipment ID, or clear the search to see everything in the ledger.'
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
