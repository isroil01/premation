/**
 * New Multicam's angle layers, laid into a {@link FragmentBuilder}: every
 * angle a full-frame footage layer tagged with its angle number
 * (`__multicamAngle`), angle 1 visible and the rest at opacity 0
 * (layout/Multicam/multicamEdits.ts pastes them into the new composition).
 */

import { makeNode } from '@core/scene/layerBuilders';
import { MULTICAM_ANGLE_PROP } from '@core/composition/multicam';
import type { ImportedAsset } from '@stores/assetStore';
import type { FragmentBuilder } from './fragmentBuilder';

export function buildMulticamAngles(
  b: FragmentBuilder,
  comp: string,
  videos: readonly ImportedAsset[],
  width: number,
  height: number,
): void {
  videos.forEach((asset, i) => {
    const node = makeNode(asset.type === 'video' ? 'video' : 'image', asset.name);
    node.transform.position = { x: width / 2, y: height / 2 };
    for (const c of node.components) {
      const props = c.props as Record<string, unknown>;
      if (c.type === 'Transform') {
        Object.assign(props, { src: asset.src, assetId: asset.id, width, height, x: width / 2, y: height / 2, [MULTICAM_ANGLE_PROP]: i + 1 });
      }
      if (c.type === 'Style') props.opacity = i === 0 ? 100 : 0;
    }
    b.addChild(comp, node);
  });
}
