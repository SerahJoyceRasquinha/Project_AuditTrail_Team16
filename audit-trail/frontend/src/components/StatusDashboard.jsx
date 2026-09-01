import { useEffect, useState } from 'react';
import { BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import * as api from '../services/apiClient.js';
import { ErrorBlock, LoadingBlock } from './StatusBlocks.jsx';
import styles from '../styles/dashboard.module.css';

const COLORS = {
  primary: '#3b82f6',
  success: '#10b981',
  warning: '#f59e0b',
  danger: '#ef4444',
  info: '#0ea5e9',
  purple: '#a855f7',
};

function MetricCard({ title, value, unit = '', icon = '📊', color = 'primary' }) {
  return (
    <div className={styles.metricCard} style={{ borderLeftColor: COLORS[color] }}>
      <div className={styles.metricHeader}>
        <span className={styles.metricIcon}>{icon}</span>
        <h3 className={styles.metricTitle}>{title}</h3>
      </div>
      <div className={styles.metricValue}>
        {value}
        {unit && <span className={styles.metricUnit}>{unit}</span>}
      </div>
    </div>
  );
}

export function StatusDashboard() {
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchMetrics = async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await api.getDashboardMetrics();
        setMetrics(data);
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    };

    fetchMetrics();
    // Refresh metrics every 30 seconds
    const interval = setInterval(fetchMetrics, 30000);
    return () => clearInterval(interval);
  }, []);

  if (loading) return <LoadingBlock />;
  if (error) return <ErrorBlock error={error} />;
  if (!metrics) return <LoadingBlock />;

  // Prepare data for charts
  const stateData = [
    { name: 'Created', value: metrics.byState.CREATED, color: COLORS.info },
    { name: 'In Transit', value: metrics.byState.IN_TRANSIT, color: COLORS.warning },
    { name: 'At Port', value: metrics.byState.AT_PORT, color: COLORS.success },
  ];

  const originData = Object.entries(metrics.shipmentsByOrigin).map(([name, value]) => ({
    name,
    value,
  }));

  const destinationData = Object.entries(metrics.shipmentsByDestination).map(([name, value]) => ({
    name,
    value,
  }));

  const complianceData = [
    { name: 'Compliant', value: metrics.overallTemperatureCompliance, color: COLORS.success },
    { name: 'Breaches', value: 100 - metrics.overallTemperatureCompliance, color: COLORS.danger },
  ];

  return (
    <div className={styles.dashboard}>
      <div className={styles.dashboardHeader}>
        <h1>📊 Shipment Status Dashboard</h1>
        <p className={styles.lastUpdated}>
          Last updated: {new Date(metrics.generatedAt).toLocaleTimeString()}
        </p>
      </div>

      {/* KPI Cards Row 1 */}
      <section className={styles.section}>
        <h2>Key Performance Indicators</h2>
        <div className={styles.metricsGrid}>
          <MetricCard
            title="Active Shipments"
            value={metrics.activeShipments}
            icon="📦"
            color="info"
          />
          <MetricCard
            title="Total Shipments"
            value={metrics.totalShipments}
            icon="🎯"
            color="primary"
          />
          <MetricCard
            title="Temperature Compliance"
            value={`${metrics.overallTemperatureCompliance}%`}
            icon="❄️"
            color={metrics.overallTemperatureCompliance >= 95 ? 'success' : 'warning'}
          />
          <MetricCard
            title="Shipments with Breaches"
            value={metrics.withBreaches}
            icon="⚠️"
            color={metrics.withBreaches === 0 ? 'success' : 'danger'}
          />
        </div>
      </section>

      {/* KPI Cards Row 2 */}
      <section className={styles.section}>
        <div className={styles.metricsGrid}>
          <MetricCard
            title="Total Breaches"
            value={metrics.totalBreaches}
            icon="🔴"
            color="danger"
          />
          <MetricCard
            title="Avg Breaches/Shipment"
            value={metrics.avgBreachesPerShipment.toFixed(2)}
            icon="📈"
            color="warning"
          />
          <MetricCard
            title="Avg Delivery Time"
            value={metrics.averageDeliveryTime}
            unit=" days"
            icon="⏱️"
            color="primary"
          />
          <MetricCard
            title="On-Time Delivery Rate"
            value={`${metrics.onTimeDeliveryRate}%`}
            icon="✅"
            color={metrics.onTimeDeliveryRate >= 90 ? 'success' : 'warning'}
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
                  label={({ name, value }) => `${name}: ${value}`}
                  outerRadius={80}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {stateData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>

          {/* Temperature Compliance */}
          <div className={styles.chartContainer}>
            <h3>Temperature Compliance</h3>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={complianceData}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, value }) => `${name}: ${value}%`}
                  outerRadius={80}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {complianceData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip formatter={(value) => `${value}%`} />
              </PieChart>
            </ResponsiveContainer>
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
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" />
                    <YAxis />
                    <Tooltip />
                    <Bar dataKey="value" fill={COLORS.primary} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {destinationData.length > 0 && (
              <div className={styles.chartContainer}>
                <h3>Shipments by Destination</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={destinationData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" />
                    <YAxis />
                    <Tooltip />
                    <Bar dataKey="value" fill={COLORS.success} />
                  </BarChart>
                </ResponsiveContainer>
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
