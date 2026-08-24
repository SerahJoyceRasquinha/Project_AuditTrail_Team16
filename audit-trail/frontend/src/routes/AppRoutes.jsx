import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from '../layouts/AppLayout.jsx';
import { LandingPage } from '../pages/LandingPage.jsx';
import { DashboardPage } from '../pages/DashboardPage.jsx';
import { ShipmentPage } from '../pages/ShipmentPage.jsx';
import { NotFoundPage } from '../pages/NotFoundPage.jsx';

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<LandingPage />} />
        <Route path="/shipments" element={<DashboardPage />} />
        <Route path="/shipment/:id" element={<ShipmentPage />} />
        {/* Keep the old root dashboard URL working for bookmarked links. */}
        <Route path="/dashboard" element={<Navigate to="/shipments" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
