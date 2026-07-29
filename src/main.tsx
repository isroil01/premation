import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppRouter } from './routes/AppRouter';
import { ErrorBoundary } from '@components/ErrorBoundary/ErrorBoundary';
import { TooltipProvider } from '@components/Tooltip';
import { setLocalFirst } from '@core/config/flags';
import { purgeLegacyLocalAiKeys } from '@core/api/purgeLocalKeys';
import './styles/global.css';

// FIRST, before any store hydrates or any plugin host boots: remove plaintext
// provider keys an earlier build mirrored into localStorage. Ordering is the
// whole point — a purge that runs after a plugin can read storage is theatre.
purgeLegacyLocalAiKeys();

// Read the LOCAL_FIRST build flag once, here at the entry — `import.meta.env` is
// a Vite construct, and keeping it out of shared modules avoids Jest's CJS
// `import.meta` breakage. Enables `.motion` directory-bundle save/open.
setLocalFirst(import.meta.env.VITE_LOCAL_FIRST === '1' || import.meta.env.VITE_LOCAL_FIRST === 'true');

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
