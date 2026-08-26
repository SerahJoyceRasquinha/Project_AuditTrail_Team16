import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from '../layouts/AppLayout.jsx';
import { LandingPage } from '../pages/LandingPage.jsx';
import { DashboardPage } from '../pages/DashboardPage.jsx';
import { ShipmentPage } from '../pages/ShipmentPage.jsx';
import { NotFoundPage } from '../pages/NotFoundPage.jsx';
import { LoginPage } from '../pages/LoginPage.jsx';
import { useAuth } from '../auth/AuthContext.jsx';

function RequireAuth({ children }) {
  const { user } = useAuth();
  return user ? children : <Navigate to="/login" replace />;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<AppLayout />}>
        <Route index element={<LandingPage />} />
        <Route path="/shipments" element={<RequireAuth><DashboardPage /></RequireAuth>} />
        <Route path="/shipment/:id" element={<RequireAuth><ShipmentPage /></RequireAuth>} />
        {/* Keep the old root dashboard URL working for bookmarked links. */}
        <Route path="/dashboard" element={<Navigate to="/shipments" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
