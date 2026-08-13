/**
 * The consent screen, reachable from anywhere.
 *
 * Installing is now possible from four places — the manager modal, the sidebar
 * row, the detail tab, and a deep link — and every one of them must land on the
 * SAME screen. Consent is the moment the user is told what a plugin will be
 * able to do, and it is the only moment; a surface that installed without it,
 * for any reason, would quietly make the whole permission model optional.
 *
 * Mounted once at app level and registered with `installFromRegistry`, so the
 * non-React callers (a store action, a menu handler, an IPC listener) can raise
 * it without owning a component.
 */

import { useEffect, useRef, useState } from 'react';
import type { PluginPackage } from '@core/plugins/pluginPackage';
import { setConsentHost, setKeyChangeHost, type InstallOrigin, type KeyChangeRequest } from './installFromRegistry';
import { ConsentSheet, ConsentOverlay } from './ConsentSheet';
import { KeyChangeSheet } from './KeyChangeSheet';

export function PluginConsentHost(): JSX.Element | null {
  const [pending, setPending] = useState<{ pkg: PluginPackage; origin: InstallOrigin } | null>(null);
  const [keyChange, setKeyChange] = useState<KeyChangeRequest | null>(null);
  /** Resolves the promise `updateFromRegistry` is blocked on. */
  const decide = useRef<((accepted: boolean) => void) | null>(null);

  useEffect(() => {
    setConsentHost((pkg, origin) => setPending({ pkg, origin }));

    /*
      The key-change prompt resolves a PROMISE the update flow is waiting on,
      not a callback it fires and forgets. A security prompt whose caller does
      not wait for the answer is decoration.
    */
    setKeyChangeHost(
      (req) =>
        new Promise<boolean>((resolve) => {
          decide.current = resolve;
          setKeyChange(req);
        }),
    );

    // Deregistered on unmount so a stale closure cannot hold a dead setState —
    // and so the callers report "unavailable" rather than silently doing
    // nothing if this ever fails to mount.
    return () => {
      setConsentHost(null);
      setKeyChangeHost(null);
      // An unmount mid-prompt resolves as a DECLINE. Leaving it dangling hangs
      // the update forever; resolving true would accept a key change nobody
      // answered.
      decide.current?.(false);
      decide.current = null;
    };
  }, []);

  if (keyChange) {
    return (
      <KeyChangeSheet
        request={keyChange}
        onDecide={(accepted) => {
          setKeyChange(null);
          const resolve = decide.current;
          decide.current = null;
          resolve?.(accepted);
        }}
      />
    );
  }

  if (!pending) return null;

  return (
    <ConsentOverlay>
      <ConsentSheet
        pkg={pending.pkg}
        source="registry"
        origin={pending.origin}
        onDone={() => setPending(null)}
      />
    </ConsentOverlay>
  );
}
