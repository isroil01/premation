import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppRouter } from './routes/AppRouter';
import { ErrorBoundary } from '@components/ErrorBoundary/ErrorBoundary';
import { TooltipProvider } from '@components/Tooltip';
import { setLocalFirst } from '@core/config/flags';
import { tryRegisterSamOnnxFromUrl } from '@core/tracking/samOnnxLoader';
import { restoreSamModelAtBoot } from '@core/tracking/samModelInstall';
import { parseEdition, setEdition } from '@core/config/edition';
import { purgeLegacyLocalAiKeys } from '@core/api/purgeLocalKeys';
import { installPluginNetBridge } from '@core/plugins/pluginNetBridge';
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

// Turn on the DNS-rebinding check for plugin network requests. It needs a
// resolver, the renderer has no way to resolve a name, and without one the
// check does not run at all — a declared host pointing at 127.0.0.1 would pass
// every check that reads the name as text. Installed here, before any plugin
// host boots, for the same reason the key purge above is first: a protection
// installed after the thing it protects is already running is theatre. No-ops
// in a browser build, and `netGuardStatus()` reports that rather than implying
// a guard that is not running.
installPluginNetBridge();

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

// Object Matte — neural, one-click subject selection. The segmenter and its
// registration hook have been in the tree since the tracking column shipped;
// what they were missing was a model. Point `VITE_SAM_MODEL_URL` at a hosted
// SAM-class ONNX decoder and it is registered at boot; clicks in the Roto tool
// then prefer it, with GrabCut as the fallback the user already had. Absent,
// nothing changes — the loader is a dynamic import and costs nothing unused.
{
  const samUrl = import.meta.env.VITE_SAM_MODEL_URL as string | undefined;
  if (samUrl) {
    void tryRegisterSamOnnxFromUrl(samUrl).then((r) => {
      if (r.status === 'ok') console.info('[sam] neural segmenter ready');
      else console.warn(`[sam] ${r.status}: ${r.reason}`);
    });
  } else {
    /*
      No build-time URL: look for a model the USER installed.

      This is the path that makes the feature reachable at all. A Vite env var
      is a thing a packager sets, not a thing a person does, so the model now
      arrives through Settings ▸ Object Matte — downloaded once, on an explicit
      press, and cached in IndexedDB. This call touches the network never: it
      reads the cache, and returns immediately when it is empty.
    */
    restoreSamModelAtBoot();
  }
}

/**
 * Apply the async document-font stylesheet.
 *
 * index.html parks it at `media="print"` so it does not block first paint; this
 * flips it to `all` once it has loaded. It lives here rather than in an inline
 * `onload` attribute because the app's own CSP (`script-src 'self'`) refuses
 * inline event handlers — which it did, on every boot, so `media` stayed
 * `print` and every user-selectable font silently fell back.
 *
 * `sheet` is non-null once a stylesheet has loaded, which covers the race where
 * it finished before this module ran; otherwise wait for `load`. Failure is
 * deliberately silent: a missing webfont costs a fallback face, and the local
 * edition may have no network at all by design.
 */
const docFonts = document.getElementById('doc-fonts') as HTMLLinkElement | null;
if (docFonts) {
  const apply = (): void => { docFonts.media = 'all'; };
  if (docFonts.sheet) apply();
  else docFonts.addEventListener('load', apply, { once: true });
}

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
