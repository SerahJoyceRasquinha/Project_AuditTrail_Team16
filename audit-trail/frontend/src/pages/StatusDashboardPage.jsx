import { StatusDashboard } from '../components/StatusDashboard.jsx';

/**
 * StatusDashboardPage - The executive dashboard showing KPIs and metrics.
 *
 * Displays aggregated metrics across all active shipments:
 * - Shipment counts by lifecycle state
 * - Temperature compliance statistics
 * - On-time delivery rates
 * - Geographic distribution
 * - Breach trends
 */
export function StatusDashboardPage() {
  return <StatusDashboard />;
}
