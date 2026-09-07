import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import * as api from '../services/apiClient.js';
import { useShipmentStream } from '../hooks/useShipmentStream.js';
import { ErrorBlock, LoadingBlock } from './StatusBlocks.jsx';
import { useChartPalette } from '../hooks/useTheme.js';
import styles from '../styles/dashboard.module.css';

/**
 * Chart colours come from the application's shared palette rather than from a
 * private list of hex codes.
 *
 * The previous list was a generic blue/green/amber set with no relationship to
 * the rest of the interface, and it was fixed regardless of theme - which is
 * most of why this dashboard read as a separate application. Mapping the
 * dashboard's semantic slots onto the shared signal colours means a breach is
 * the same red here as it is on the shipment page, and both themes are handled
 * in one place.
 */
function slots(palette) {
  return {
    primary: palette.blue,
    success: palette.green,
    warning: palette.amber,
    danger: palette.red,
    info: palette.teal,
    purple: palette.violet,
  };
}

/**
 * The two explanations that accompany every figure.
 *
 * Rendered inline rather than behind a hover tooltip. A dashboard is read by
 * people who did not build it, and a number whose definition is one hover away
 * is a number that gets misread in the meeting where it matters - especially
 * the ones here with real subtleties, like a compliance figure that counts
 * shipments rather than readings, or geographic bars truncated to the top five.
 * A tooltip is also unreachable on a touchscreen and invisible when the page is
 * printed, which are two of the ways this screen actually gets used.
 */
function Explanation({ definition }) {
  if (!definition) return null;

  return (
    <div className={styles.explain}>
      <div className={styles.explainRow}>
        <span className={styles.explainLabel}>In plain English</span>
        <span className={styles.explainText}>{definition.plain}</span>
      </div>
      <div className={styles.explainRow}>
        <span className={styles.explainLabel}>Technically</span>
        <span className={styles.explainText}>{definition.technical}</span>
      </div>
      {definition.formula ? <code className={styles.explainFormula}>{definition.formula}</code> : null}
    </div>
  );
}

/**
 * Turns the backend's state counts into pie slices.
 *
 * Exported so it can be tested directly: Recharts needs a measured container to
 * draw anything, and jsdom reports every element as zero-sized, so asserting on
 * rendered slice labels tests the test environment rather than this mapping.
 * The mapping is where the bug was, so the mapping is what is tested.
 *
 * It reads whatever states the backend sent rather than naming them. The
 * previous version listed CREATED, IN_TRANSIT and AT_PORT explicitly, so every
 * delivered (UNLOADED) shipment was counted in the cards above and then
 * silently missing from this chart.
 */
export function buildStateChartData(byState, colors) {
  const palette = [colors.info, colors.warning, colors.success, colors.primary, colors.purple];

  const titleCase = (value) =>
    value
      .toLowerCase()
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');

  /**
   * Every state the backend reports is kept, including the empty ones, so a
   * state with no shipments is still accounted for rather than silently
   * missing. Suppressing the *label* for a zero slice is handled at render
   * time - see the `label` prop on the Pie - because a zero-area slice still
   * gets a label from Recharts, and several of them land on the same point and
   * overprint into an unreadable smear.
   */
  return Object.entries(byState ?? {}).map(([name, value], index) => ({
    name: titleCase(name),
    value,
    color: palette[index % palette.length],
  }));
}

function MetricCard({ title, value, unit = '', icon = '📊', color = 'primary', colors, definition }) {
  return (
    <div className={styles.metricCard} style={{ borderLeftColor: colors[color] }}>
      <div className={styles.metricHeader}>
        <span className={styles.metricIcon}>{icon}</span>
        <h3 className={styles.metricTitle}>{title}</h3>
      </div>
      <div className={styles.metricValue}>
        {value}
        {unit && <span className={styles.metricUnit}>{unit}</span>}
      </div>
      <Explanation definition={definition} />
    </div>
  );
}

export function StatusDashboard() {
  const palette = useChartPalette();
  const COLORS = slots(palette);

  const [metrics, setMetrics] = useState(null);
  const [definitions, setDefinitions] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [exportingFormat, setExportingFormat] = useState(null);
  const [exportNotice, setExportNotice] = useState(null);

  /**
   * `loading` is only raised for the first fetch.
   *
   * A refresh triggered by someone recording a reading should update the
   * numbers in place; tearing the dashboard down to a skeleton every time an
   * event arrives makes it flicker and loses the reader's scroll position.
   */
  const loadedOnce = useRef(false);

  const fetchMetrics = useCallback(async () => {
    try {
      if (!loadedOnce.current) setLoading(true);
      setError(null);
      const data = await api.getDashboardMetrics();
      setMetrics(data);
      loadedOnce.current = true;
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMetrics();
    // A slow backstop. The stream below is what makes this feel immediate; the
    // poll is what keeps it correct when the stream is unavailable.
    const interval = setInterval(fetchMetrics, 30000);
    return () => clearInterval(interval);
  }, [fetchMetrics]);

  /**
   * Live updates.
   *
   * Recording a temperature changed the shipment page immediately but left this
   * dashboard showing stale totals for up to thirty seconds, which reads as the
   * metrics being disconnected from the readings. Subscribing to the same
   * notification stream the ledger uses closes that gap without introducing a
   * second source of truth: the notification only says something changed, and
   * the response is to re-run the ordinary query.
   */
  useShipmentStream({
    shipmentId: null,
    enabled: true,
    onNotification: () => fetchMetrics(),
  });

  /**
   * The definitions are fetched once and never polled: they change when someone
   * edits the source module, not on a schedule. A failure here is deliberately
   * not raised as a page error - losing the captions leaves a degraded
   * dashboard, not a broken one, and the numbers are still worth showing.
   */
  useEffect(() => {
    let cancelled = false;
    api
      .getMetricDefinitions()
      .then((data) => {
        if (!cancelled) setDefinitions(data);
      })
      .catch(() => {
        if (!cancelled) setDefinitions(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const definitionFor = useMemo(() => {
    const byKey = Object.fromEntries((definitions?.metrics ?? []).map((entry) => [entry.key, entry]));
    return (key) => byKey[key] ?? null;
  }, [definitions]);

  const chartFor = useMemo(() => {
    const byKey = Object.fromEntries((definitions?.charts ?? []).map((entry) => [entry.key, entry]));
    return (key) => byKey[key] ?? null;
  }, [definitions]);

  /**
   * Exports are generated by the backend, not serialised from this component.
   *
   * Serialising what is on screen would produce a file whose contents depend on
   * when the 30-second poll last fired. Asking the server means the report is
   * built from the same query the dashboard reads, with the charts redrawn from
   * the same numbers, and it behaves identically from curl.
   */
  const runExport = async (format) => {
    setExportingFormat(format);
    setExportNotice(null);
    try {
      await api.exportDashboardMetrics(format);
      setExportNotice(
        `${format.toUpperCase()} dashboard report downloaded. It contains every metric with its definition, and the charts.`
      );
    } catch (err) {
      setExportNotice(`Could not download the ${format.toUpperCase()} report: ${err.message}`);
    } finally {
      setExportingFormat(null);
    }
  };

  if (loading && !metrics) return <LoadingBlock />;
  if (error) return <ErrorBlock error={error} />;
  if (!metrics) return <LoadingBlock />;

  // Prepare data for charts
  /**
   * Built from whatever states the backend returned, not from a hand-written
   * list of three.
   *
   * The previous version named CREATED, IN_TRANSIT and AT_PORT explicitly, so
   * every delivered (UNLOADED) shipment was counted in the totals above and
   * then silently missing from this chart - the pie emptied out as shipments
   * completed, while the cards still said the fleet was there. The backend now
   * returns one bucket per SHIPMENT_STATES value; rendering whatever it sends
   * means a state added to the domain appears here without a frontend change.
   */
  const stateData = buildStateChartData(metrics.byState, COLORS);

  const originData = Object.entries(metrics.shipmentsByOrigin).map(([name, value]) => ({
    name,
    value,
  }));

  const destinationData = Object.entries(metrics.shipmentsByDestination).map(([name, value]) => ({
    name,
    value,
  }));

  /**
   * The compliance pie is drawn from reading-level compliance, not
   * shipment-level.
   *
   * It used to render overallTemperatureCompliance, which counts shipments: one
   * shipment that breached once out of five readings made the chart read
   * "Breaches: 100%" while that shipment's own page said "5 readings, 1
   * breach". Both numbers were correct and the pair was indefensible. Readings
   * are what the chart appears to be about, so readings are what it now shows.
   */
  const hasReadings = (metrics.totalTemperatureReadings ?? 0) > 0;
  const readingCompliance = metrics.readingTemperatureCompliance;
  const complianceData = hasReadings
    ? [
        { name: 'In range', value: readingCompliance, color: COLORS.success },
        { name: 'Breached', value: 100 - readingCompliance, color: COLORS.danger },
      ]
    : [];

  return (
    <div className={styles.dashboard}>
      <div className={styles.dashboardHeader}>
        <h1>📊 Shipment Status Dashboard</h1>
        <p className={styles.lastUpdated}>
          Last updated: {new Date(metrics.generatedAt).toLocaleTimeString()}
        </p>

        {/*
          Two formats, matching the audit export on the shipment page: a PDF to
          read or circulate, and a CSV to take into a spreadsheet. Both carry the
          metric definitions and the charts, so the file explains itself to
          whoever opens it later without the sender having to.
        */}
        <div className={styles.exportBar}>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => runExport('pdf')}
            disabled={Boolean(exportingFormat)}
          >
            {exportingFormat === 'pdf' ? 'Preparing PDF…' : 'Export PDF'}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => runExport('csv')}
            disabled={Boolean(exportingFormat)}
          >
            {exportingFormat === 'csv' ? 'Preparing CSV…' : 'Export CSV'}
          </button>
          <span className={styles.exportHint}>
            Includes every metric with its explanation, plus the charts below.
          </span>
        </div>
        {exportNotice ? (
          <p className={styles.exportHint} role="status">
            {exportNotice}
          </p>
        ) : null}
      </div>

      {/*
        Stated once, at the top, rather than repeated on every card: where these
        numbers come from, which shipments they cover, and how fresh they are.
        The freshness note matters most - the read model trails the event log, so
        a command issued seconds ago may not be counted yet, and a dashboard that
        does not say so invites someone to conclude their command was lost.
      */}
      {definitions?.basis ? (
        <div className={styles.basis}>
          <span className={styles.basisItem}>
            <strong>Source. </strong>
            {definitions.basis.source}
          </span>
          <span className={styles.basisItem}>
            <strong>Scope. </strong>
            {definitions.basis.scope}
          </span>
          <span className={styles.basisItem}>
            <strong>Freshness. </strong>
            {definitions.basis.freshness}
          </span>
        </div>
      ) : null}

      {/* KPI Cards Row 1 */}
      <section className={styles.section}>
        <h2>Key Performance Indicators</h2>
        <div className={styles.metricsGrid}>
          <MetricCard
            colors={COLORS}
            title="Active Shipments"
            value={metrics.activeShipments}
            icon="📦"
            color="info"
            definition={definitionFor('activeShipments')}
          />
          <MetricCard
            colors={COLORS}
            title="Total Shipments"
            value={metrics.totalShipments}
            icon="🎯"
            color="primary"
            definition={definitionFor('totalShipments')}
          />
          {/*
            Archived shipments used to be invisible here - worse than invisible,
            they quietly shrank the "Total Shipments" figure when filed away.
            Now the total holds and this card accounts for the difference, so
            active + archived always reconciles to the total on screen.
          */}
          <MetricCard
            colors={COLORS}
            title="Archived Shipments"
            value={metrics.archivedShipments ?? 0}
            icon="🗄️"
            color="purple"
            definition={definitionFor('archivedShipments')}
          />
          <MetricCard
            colors={COLORS}
            title="Reading Compliance"
            value={readingCompliance === null || readingCompliance === undefined ? '—' : `${readingCompliance}%`}
            icon="❄️"
            color={readingCompliance === null || readingCompliance === undefined ? 'primary' : readingCompliance >= 95 ? 'success' : 'warning'}
            definition={definitionFor('readingTemperatureCompliance')}
          />
          <MetricCard
            colors={COLORS}
            title="Shipments Fully Compliant"
            value={
              metrics.overallTemperatureCompliance === null || metrics.overallTemperatureCompliance === undefined
                ? '—'
                : `${metrics.overallTemperatureCompliance}%`
            }
            icon="📦"
            color={metrics.overallTemperatureCompliance >= 95 ? 'success' : 'warning'}
            definition={definitionFor('overallTemperatureCompliance')}
          />
          <MetricCard
            colors={COLORS}
            title="Shipments with Breaches"
            value={metrics.withBreaches}
            icon="⚠️"
            color={metrics.withBreaches === 0 ? 'success' : 'danger'}
            definition={definitionFor('withBreaches')}
          />
        </div>
      </section>

      {/* KPI Cards Row 2 */}
      <section className={styles.section}>
        <div className={styles.metricsGrid}>
          <MetricCard
            colors={COLORS}
            title="Total Breaches"
            value={metrics.totalBreaches}
            icon="🔴"
            color="danger"
            definition={definitionFor('totalBreaches')}
          />
          <MetricCard
            colors={COLORS}
            title="Avg Breaches/Shipment"
            value={(metrics.avgBreachesPerShipment ?? 0).toFixed(2)}
            icon="📈"
            color="warning"
            definition={definitionFor('avgBreachesPerShipment')}
          />
          <MetricCard
            colors={COLORS}
            title="Avg Delivery Time"
            value={metrics.averageDeliveryTime === null || metrics.averageDeliveryTime === undefined ? '—' : metrics.averageDeliveryTime}
            unit={metrics.averageDeliveryTime === null || metrics.averageDeliveryTime === undefined ? '' : ' days'}
            icon="⏱️"
            color="primary"
            definition={definitionFor('averageDeliveryTime')}
          />
          <MetricCard
            colors={COLORS}
            title="On-Time Delivery Rate"
            value={metrics.onTimeDeliveryRate === null || metrics.onTimeDeliveryRate === undefined ? '—' : `${metrics.onTimeDeliveryRate}%`}
            icon="✅"
            color={
              metrics.onTimeDeliveryRate === null || metrics.onTimeDeliveryRate === undefined
                ? 'primary'
                : metrics.onTimeDeliveryRate >= 90
                  ? 'success'
                  : 'warning'
            }
            definition={definitionFor('onTimeDeliveryRate')}
          />
        </div>
      </section>

      {/* Charts Section */}
      <section className={styles.section}>
        <h2>Shipment Distribution</h2>
        <div className={styles.chartsGrid}>
          {/* Shipment State Distribution */}
          <div className={styles.chartContainer}>
            <h3>By Lifecycle State</h3>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={stateData}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  stroke={palette.surface}
                  label={({ name, value }) => (value > 0 ? `${name}: ${value}` : null)}
                  outerRadius={80}
                  fill={COLORS.info}
                  dataKey="value"
                >
                  {stateData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip contentStyle={tooltipStyle(palette)} />
              </PieChart>
            </ResponsiveContainer>
            <p className={styles.chartCaption}>
              {stateData.map((slice) => `${slice.name}: ${slice.value}`).join(' · ')}
            </p>
            <Explanation definition={chartFor('byState')} />
          </div>

          {/* Temperature Compliance */}
          <div className={styles.chartContainer}>
            <h3>Temperature Compliance</h3>
            {hasReadings ? (
            <>
            <p className={styles.chartCaption}>
              {metrics.totalTemperatureReadings} readings · {metrics.breachReadings} outside range
            </p>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={complianceData}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  stroke={palette.surface}
                  label={({ name, value }) => `${name}: ${value}%`}
                  outerRadius={80}
                  fill={COLORS.info}
                  dataKey="value"
                >
                  {complianceData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip formatter={(value) => `${value}%`} contentStyle={tooltipStyle(palette)} />
              </PieChart>
            </ResponsiveContainer>
            </>
            ) : (
              <p className={styles.emptyChart}>
                No temperature readings have been recorded yet, so there is nothing to measure
                compliance against. This is not the same as 0% compliant.
              </p>
            )}
            <Explanation definition={chartFor('temperatureCompliance')} />
          </div>
        </div>
      </section>

      {/* Origin/Destination Charts */}
      {(originData.length > 0 || destinationData.length > 0) && (
        <section className={styles.section}>
          <h2>Geographic Breakdown</h2>
          <div className={styles.chartsGrid}>
            {originData.length > 0 && (
              <div className={styles.chartContainer}>
                <h3>Shipments by Origin</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={originData}>
                    <CartesianGrid strokeDasharray="3 3" stroke={palette.grid} />
                    <XAxis dataKey="name" stroke={palette.axis} fontSize={11} />
                    <YAxis stroke={palette.axis} fontSize={11} allowDecimals={false} />
                    <Tooltip
                      cursor={{ fill: palette.grid, fillOpacity: 0.35 }}
                      contentStyle={tooltipStyle(palette)}
                    />
                    <Bar dataKey="value" fill={COLORS.primary} />
                  </BarChart>
                </ResponsiveContainer>
                <Explanation definition={chartFor('shipmentsByOrigin')} />
              </div>
            )}

            {destinationData.length > 0 && (
              <div className={styles.chartContainer}>
                <h3>Shipments by Destination</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={destinationData}>
                    <CartesianGrid strokeDasharray="3 3" stroke={palette.grid} />
                    <XAxis dataKey="name" stroke={palette.axis} fontSize={11} />
                    <YAxis stroke={palette.axis} fontSize={11} allowDecimals={false} />
                    <Tooltip
                      cursor={{ fill: palette.grid, fillOpacity: 0.35 }}
                      contentStyle={tooltipStyle(palette)}
                    />
                    <Bar dataKey="value" fill={COLORS.success} />
                  </BarChart>
                </ResponsiveContainer>
                <Explanation definition={chartFor('shipmentsByDestination')} />
              </div>
            )}
          </div>
        </section>
      )}

      {/* Summary Stats */}
      <section className={styles.section + ' ' + styles.summary}>
        <h2>Summary</h2>
        <div className={styles.summaryGrid}>
          <div className={styles.summaryItem}>
            <span className={styles.summaryLabel}>Active Shipments:</span>
            <span className={styles.summaryValue}>{metrics.activeShipments}</span>
          </div>
          <div className={styles.summaryItem}>
            <span className={styles.summaryLabel}>Total Breach Incidents:</span>
            <span className={styles.summaryValue}>{metrics.totalBreaches}</span>
          </div>
          <div className={styles.summaryItem}>
            <span className={styles.summaryLabel}>System Compliance:</span>
            <span className={styles.summaryValue}>{metrics.overallTemperatureCompliance}%</span>
          </div>
          <div className={styles.summaryItem}>
            <span className={styles.summaryLabel}>On-Time Delivery:</span>
            <span className={styles.summaryValue}>{metrics.onTimeDeliveryRate}%</span>
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * Recharts' tooltip is rendered inline, so its surface has to be handed to it
 * as a style object rather than set in the stylesheet.
 */
function tooltipStyle(palette) {
  return {
    background: palette.surface,
    border: `1px solid ${palette.border}`,
    borderRadius: 4,
    color: palette.text,
    fontSize: 12,
  };
}
