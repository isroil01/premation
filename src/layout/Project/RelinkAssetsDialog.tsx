/**
 * Relink missing assets after opening a portable `.motion` file.
 *
 * Local absolute paths and dead blob URLs do not travel. Rather than open a
 * project with silent blank layers, we ask the user to pick replacements.
 */

import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import { openModal } from '@stores/modalStore';
import { relinkLiveAsset } from '@core/project/localProjectIO';
import type { MissingAssetRef } from '@core/project/missingAssets';
import { bumpScene } from '@stores/sceneStore';
import { useState } from 'react';

function RelinkBody({
  missing,
  close,
}: {
  missing: MissingAssetRef[];
  close: () => void;
}): JSX.Element {
  const [left, setLeft] = useState(missing);

  const pick = (ref: MissingAssetRef): void => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,video/*,audio/*';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      if (relinkLiveAsset(ref.nodeId, url)) {
        setLeft((prev) => prev.filter((m) => m.nodeId !== ref.nodeId));
        bumpScene();
      }
    });
    input.click();
  };

  if (left.length === 0) {
    return (
      <p style={{ margin: 0, color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>
        Every missing asset has been relinked.
      </p>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ margin: 0, color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', lineHeight: 1.5 }}>
        This project references files that are not in the package. Relink them
        to keep the animation; skipping leaves those layers empty.
      </p>
      {left.map((m) => (
        <div
          key={m.nodeId}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 12px',
            border: '1px solid var(--color-border-subtle)',
            borderRadius: 'var(--radius-control)',
            background: 'var(--color-surface-2)',
          }}
        >
          <Icon name="image" size="sm" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600 }}>{m.nodeName}</div>
            <div
              style={{
                fontSize: 'var(--font-size-micro)',
                color: 'var(--color-text-secondary)',
                fontFamily: 'var(--font-family-mono)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={m.src}
            >
              {m.src || '(empty)'}
            </div>
          </div>
          <Button size="sm" variant="secondary" onClick={() => pick(m)}>
            Relink…
          </Button>
        </div>
      ))}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button size="sm" variant="ghost" onClick={close}>
          {left.length ? 'Skip for now' : 'Done'}
        </Button>
      </div>
    </div>
  );
}

export function offerRelink(missing: MissingAssetRef[]): void {
  if (!missing.length) return;
  openModal({
    id: 'relink-assets',
    title: 'Relink missing assets',
    size: 'md',
    render: (close) => <RelinkBody missing={missing} close={close} />,
  });
}
