/**
 * Proxy state and actions for one footage item.
 *
 * The brief's requirement this exists for: "a proxy silently in use looks like a
 * quality bug". So the state is always visible — which assets have one, which
 * are generating, and above all which are IN USE right now — rather than
 * inferable only from how soft the picture looks.
 *
 * Per-FILE, like Interpret Footage ▸ Alpha above it: the record lives on the
 * asset, so creating a proxy speeds up every layer using that file at once,
 * including layers in other compositions.
 *
 * The Use Proxies switch is GLOBAL and says so. It is repeated here rather than
 * hidden in a menu because this is where someone reasoning about proxies is
 * already looking, and because a per-item proxy with no visible master switch is
 * how you end up wondering why nothing got faster.
 */

import { useCallback, useState } from 'react';
import { InspectorRow } from '@components/Inspector';
import { Switch } from '@components/Switch';
import { useAssetStore } from '@stores/assetStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { isProxyInUse, proxyResolution } from '@core/assets/proxy';
import {
  startProxy,
  cancelProxy,
  attachProxy,
  detachProxy,
  proxyRefusal,
  canGenerateProxy,
  REFUSAL_TEXT,
} from '@core/assets/proxyManager';
import shared from './TransformSection.module.css';
import styles from './ProxyRow.module.css';

export function ProxyRow({ assetId }: { assetId: string }): JSX.Element | null {
  // Subscribe to the LIST so a status transition written by a background job
  // repaints this row. Reading through the selector rather than getState is what
  // makes 'generating' → 'ready' visible without a second interaction.
  const asset = useAssetStore((s) => s.assets.find((a) => a.id === assetId));
  const useProxies = usePreferenceStore((s) => s.useProxies);
  const setPref = usePreferenceStore((s) => s.set);
  const [busy, setBusy] = useState(false);

  const onCreate = useCallback(async () => {
    setBusy(true);
    try {
      await startProxy(assetId);
    } finally {
      setBusy(false);
    }
  }, [assetId]);

  const onAttach = useCallback(() => {
    // A plain file input: attaching needs no ffmpeg, which is the whole reason
    // it is offered in builds that cannot generate.
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) attachProxy(assetId, file);
    };
    input.click();
  }, [assetId]);

  if (!asset || asset.type !== 'video') return null;

  const proxy = asset.proxy;
  const generating = proxy?.status === 'generating';
  const inUse = isProxyInUse(asset, useProxies);
  const refusal = proxyRefusal(asset);
  const w = asset.metadata?.width;
  const h = asset.metadata?.height;
  const wouldBe = w && h ? proxyResolution(w, h) : null;

  /** The one line that tells you what you are actually looking at. */
  const status = (): JSX.Element => {
    if (generating) {
      return (
        <span className={`${styles.badge} ${styles.generating}`} role="status">
          Generating…
        </span>
      );
    }
    if (proxy?.status === 'failed') {
      return (
        <span className={`${styles.badge} ${styles.failed}`} title={proxy.error}>
          Failed
        </span>
      );
    }
    if (proxy?.status === 'ready') {
      return inUse ? (
        // Loud on purpose: this is the state that otherwise reads as a bug.
        <span className={`${styles.badge} ${styles.inUse}`}>Proxy in use</span>
      ) : (
        <span className={styles.badge}>Proxy ready</span>
      );
    }
    return <span className={styles.badge}>Full resolution</span>;
  };

  /** What the badge does not say: the size, or why there is no proxy. */
  const detail = (): string => {
    if (generating) return `→ ${wouldBe ? `${wouldBe.width}×${wouldBe.height}` : ''}`;
    if (proxy?.status === 'failed') return proxy.error ?? '';
    if (proxy?.status === 'ready') {
      const size = proxy.width && proxy.height ? `${proxy.width}×${proxy.height}` : 'attached file';
      return proxy.userSupplied ? `${size} · yours` : size;
    }
    // No proxy: say what one WOULD be, so the action is a known quantity.
    if (refusal === 'too-small' || refusal === 'unknown-size') return REFUSAL_TEXT[refusal];
    return wouldBe ? `Would be ${wouldBe.width}×${wouldBe.height}` : '';
  };

  return (
    <div className={styles.rows}>
      <div className={styles.statusRow}>
        {status()}
        <span className={styles.detail} title={detail()}>
          {detail()}
        </span>
      </div>

      <div className={styles.actions}>
        {generating ? (
          <button type="button" className={shared.presetChip} onClick={() => void cancelProxy(assetId)}>
            Cancel
          </button>
        ) : (
          <>
            {/* Absent, not disabled, where the build cannot generate at all —
                a permanently dead button is worse than no button. */}
            {canGenerateProxy() && (
              <button
                type="button"
                className={shared.presetChip}
                onClick={() => void onCreate()}
                disabled={busy || (refusal !== null && refusal !== 'no-ffmpeg')}
                title={refusal ? REFUSAL_TEXT[refusal] : 'Transcode a low-resolution copy for scrubbing'}
              >
                {proxy?.status === 'ready' ? 'Regenerate' : 'Create Proxy'}
              </button>
            )}
            <button
              type="button"
              className={shared.presetChip}
              onClick={onAttach}
              title="Use a low-resolution file you already have"
            >
              Attach…
            </button>
            {proxy && (
              <button
                type="button"
                className={shared.presetChip}
                onClick={() => detachProxy(assetId)}
                title={
                  proxy.userSupplied
                    ? 'Stop using your file as a proxy (the file is left alone)'
                    : 'Discard this proxy and go back to full resolution'
                }
              >
                Detach
              </button>
            )}
          </>
        )}
      </div>

      <InspectorRow label="Use Proxies" align="center">
        <Switch
          checked={useProxies}
          onChange={(e) => setPref('useProxies', e.currentTarget.checked)}
          aria-label="Use proxies in the viewport (global; never affects export)"
        />
      </InspectorRow>

      {/* Stated in the UI, not just in a doc comment: this is the promise the
          whole feature rests on, and the user has to be able to trust it. */}
      <p className={styles.hint}>
        Global, and viewport only — exports and renders always use the original.
      </p>

      {!canGenerateProxy() && <p className={styles.hint}>{REFUSAL_TEXT['no-ffmpeg']}</p>}
    </div>
  );
}
