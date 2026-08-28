import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppLayout } from '../layouts/AppLayout.jsx';
import { LandingPage } from '../pages/LandingPage.jsx';
import { DashboardPage } from '../pages/DashboardPage.jsx';
import { ShipmentPage } from '../pages/ShipmentPage.jsx';
import { NotFoundPage } from '../pages/NotFoundPage.jsx';
import { LoginPage } from '../pages/LoginPage.jsx';
import { RegisterPage } from '../pages/RegisterPage.jsx';
import { useAuth } from '../auth/AuthContext.jsx';
import { LoadingBlock } from '../components/StatusBlocks.jsx';

/**
 * Route protection.
 *
 * This is a usability layer, not a security boundary - it keeps an
 * unauthenticated visitor from landing on a page that would only fill with 401s,
 * and it remembers where they were going so the login page can send them back.
 * The actual enforcement is the backend's: every protected endpoint refuses an
 * unauthenticated caller regardless of which URL the browser managed to render.
 *
 * The pending branch matters. Restoring a session requires a round trip to
 * `/api/auth/me`, and redirecting during it would bounce an authenticated user
 * to the login page on every refresh.
 */
function RequireAuth({ children }) {
  const { isAuthenticated, isPending } = useAuth();
  const location = useLocation();

  if (isPending) {
    return (
      <div className="panel">
        <LoadingBlock label="Restoring your session" lines={3} />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return children;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route element={<AppLayout />}>
        <Route index element={<LandingPage />} />
        <Route
          path="/shipments"
          element={
            <RequireAuth>
              <DashboardPage />
            </RequireAuth>
          }
        />
        <Route
          path="/shipment/:id"
          element={
            <RequireAuth>
              <ShipmentPage />
            </RequireAuth>
          }
        />
        {/* Keep the old root dashboard URL working for bookmarked links. */}
        <Route path="/dashboard" element={<Navigate to="/shipments" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
