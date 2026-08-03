import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppRouter } from './routes/AppRouter';
import { ErrorBoundary } from '@components/ErrorBoundary/ErrorBoundary';
import { TooltipProvider } from '@components/Tooltip';
import { setLocalFirst } from '@core/config/flags';
import { parseEdition, setEdition } from '@core/config/edition';
import { purgeLegacyLocalAiKeys } from '@core/api/purgeLocalKeys';
import './styles/global.css';

// FIRST, before any store hydrates or any plugin host boots: remove plaintext
// provider keys an earlier build mirrored into localStorage. Ordering is the
// whole point — a purge that runs after a plugin can read storage is theatre.
purgeLegacyLocalAiKeys();

// Which edition this build is (`VITE_EDITION=local` for the open-source desktop
// build; anything else, including unset, is the hosted 'server' edition). Read
// here at the entry for the same reason as the flag below, and read BEFORE it
// because the local edition implies local-first storage.
const edition = parseEdition(import.meta.env.VITE_EDITION as string | undefined);
setEdition(edition);

// Report it to the shell, which resolved its OWN edition from a different build
// input (MOTION_EDITION, or the packaged manifest — a Vite define does not reach
// the main process). A disagreement matters: main gates the AI IPC on its answer,
// so a mismatch is a UI hiding the assistant over a process still serving it, or
// the reverse. Diagnostic only — main never takes its edition from this message.
// Optional-chained throughout: there is no bridge in a browser build.
void window.motionEditor?.reportEdition?.(edition);

// Read the LOCAL_FIRST build flag once, here at the entry — `import.meta.env` is
// a Vite construct, and keeping it out of shared modules avoids Jest's CJS
// `import.meta` breakage. Enables `.motion` directory-bundle save/open.
//
// The local edition turns it on unconditionally: there is no backend to autosave
// to, so an on-disk bundle is the only place a project could live. The env flag
// stays independently settable so the server edition can still opt in.
setLocalFirst(
  edition === 'local' ||
    import.meta.env.VITE_LOCAL_FIRST === '1' ||
    import.meta.env.VITE_LOCAL_FIRST === 'true',
);

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
