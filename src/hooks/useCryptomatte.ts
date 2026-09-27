/**
 * The Cryptomatte ID set a footage item's EXR carries, as the ENGINE reports
 * it (`getCryptomatte`, ENGINE_API.md §15.12). Asked when the item changes in
 * the mirror and when the engine announces the item's decode
 * (`assetStatusChanged` — the manifest arrives with the decode, not a
 * revision); null until the answer lands, and where the engine cannot say.
 */

import { useEffect, useState } from 'react';
import type { CryptomatteInfo } from '@motion/engine-api';
import { engine, subscribeEngine } from '@core/engine/engineInstance';
import { useMirrorKeys } from './useMirror';

export function useCryptomatte(item: string | null | undefined): CryptomatteInfo | null {
  const rev = useMirrorKeys(item ? [`item:${item}`] : []);
  const [answer, setAnswer] = useState<{ item: string; info: CryptomatteInfo | null } | null>(null);
  const [decoded, setDecoded] = useState(0);
  useEffect(() => {
    if (!item) return undefined;
    return subscribeEngine((batch) => {
      if (batch.events.some((e) => e.type === 'assetStatusChanged' && e.item === item)) setDecoded((n) => n + 1);
    });
  }, [item]);
  useEffect(() => {
    if (!item) return undefined;
    let live = true;
    void engine().query({ type: 'getCryptomatte', item }).then((res) => {
      if (live) setAnswer({ item, info: res.ok ? res.value : null });
    });
    return () => {
      live = false;
    };
  }, [item, rev, decoded]);
  return answer && answer.item === item ? answer.info : null;
}
