import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppRouter } from './routes/AppRouter';
import { ErrorBoundary } from '@components/ErrorBoundary/ErrorBoundary';
import './styles/global.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found in index.html');
}

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary scope="root">
      <AppRouter />
    </ErrorBoundary>
  </StrictMode>,
);
