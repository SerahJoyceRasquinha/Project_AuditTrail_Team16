import { BrowserRouter } from 'react-router-dom';
import { AppRoutes } from '../routes/AppRoutes.jsx';
import { ErrorBoundary } from '../components/ErrorBoundary.jsx';
import { AuthProvider } from '../auth/AuthContext.jsx';

export function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter><AuthProvider><AppRoutes /></AuthProvider></BrowserRouter>
    </ErrorBoundary>
  );
}
