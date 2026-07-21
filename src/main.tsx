import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppRouter } from './routes/AppRouter';
import { ErrorBoundary } from '@components/ErrorBoundary/ErrorBoundary';
import { TooltipProvider } from '@components/Tooltip';
import './styles/global.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found in index.html');
}

// TooltipProvider is pure context (delay/skip config) with no dependency on the
// engine boot, so it lives at the true root: the global TitleBar renders on
// /login and /dashboard — outside the Providers boot gate — and its IconButtons
// need a provider too. One provider for every route.
createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary scope="root">
      <TooltipProvider>
        <AppRouter />
      </TooltipProvider>
    </ErrorBoundary>
  </StrictMode>,
);
