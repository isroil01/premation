/**
 * A native plugin effect's card header, as AE draws a third-party effect
 * (owner-approved mockup 2026-10-20, item 7):
 *
 *     ▾ fx [icon] Deep Glow ........ Presets ▾  Studio  ⓘ  Reset ⋯
 *
 *   - the plugin's icon: the manifest's `icon` (a picture in the bundle's ui/,
 *     shown as `plugin-ui://<id>/…`), else the store listing's icon when the
 *     plugin was installed from the store, else nothing;
 *   - Presets ▾: the presets the plugin ships for this effect, applied onto
 *     THIS instance (one undo entry);
 *   - the panel button (bundle ships ui/index.html): the manifest's
 *     `panelTitle` ("Studio"), else "Panel" — opens the floating panel window;
 *   - ⓘ: the plugin's PR_CMD_ABOUT text.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { PluginInfo } from '@motion/engine-api';
import { Button } from '@components/Button';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { Icon } from '@components/Icon';
import { IconButton } from '@components/IconButton';
import { Popover } from '@components/Popover';
import { TooltipProvider } from '@components/Tooltip';
import type { Effect } from '@core/inspector/effectCatalog';
import type { PluginEffectDef } from '@core/inspector/pluginEffectDefs';
import { pluginContribRevision, pluginForEffect, subscribePluginContrib } from '@core/nativePlugins/pluginContrib';
import { pluginPresetsFor } from '@core/nativePlugins/pluginPresets';
import { pluginIconUrl, storeIcon } from '@layout/Plugins/pluginIcons';
import { PluginPanelWindow } from './PluginPanel';
import panel from './EffectsPanel.module.css';
import { t } from '@core/i18n';

// The icon's sources live with the plugin's dock tab, which shows the same picture.
export { pluginIconUrl } from '@layout/Plugins/pluginIcons';

function usePlugin(type: string): PluginInfo | undefined {
  useSyncExternalStore(subscribePluginContrib, pluginContribRevision, pluginContribRevision);
  return pluginForEffect(type);
}

/** The plugin's icon in the card header (16 px), or nothing. */
export function PluginHeaderIcon({ type }: { type: string }): JSX.Element | null {
  const plugin = usePlugin(type);
  const own = pluginIconUrl(plugin);
  const [store, setStore] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  const id = plugin?.id;
  useEffect(() => {
    if (own || !id) return;
    let alive = true;
    void storeIcon(id).then((url) => { if (alive) setStore(url); });
    return () => { alive = false; };
  }, [own, id]);
  const src = own ?? store;
  if (!src || broken) return null;
  return <img className={panel.pluginIcon} src={src} alt="" width={16} height={16} onError={() => setBroken(true)} />;
}

/** Presets ▾, the panel button and About, right of the effect's name. */
export function PluginHeaderActions({
  nodeId,
  effect,
  def,
  presetItems,
}: {
  nodeId: string;
  effect: Effect;
  def: PluginEffectDef;
  /** The Apply Preset rows (the header menu's own), so both openers apply the same way. */
  presetItems: () => DropdownItem[];
}): JSX.Element {
  const plugin = usePlugin(effect.type);
  const [panelOpen, setPanelOpen] = useState(false);
  const hasPresets = pluginPresetsFor(effect.type).length > 0;
  const stop = (ev: React.MouseEvent): void => ev.stopPropagation();
  // Its own provider: the card is mounted provider-less by suites and pop-outs (see TransformSection).
  return (
    <TooltipProvider>
    <span className={panel.pluginHeaderActions} onMouseDown={stop}>
      {hasPresets ? (
        <Dropdown
          placement="bottom-end"
          trigger={(
            <Button size="xs" variant="secondary" aria-label={t('effects.pluginCard.presetsAria', '{name} presets', { name: def.label })} title={t('effects.pluginCard.presetsTitle', 'Apply one of the plugin\'s presets to this effect')}>
              {t('effects.pluginCard.presets', 'Presets')} <Icon name="chevron-down" size="sm" />
            </Button>
          )}
          items={presetItems}
        />
      ) : null}
      {plugin?.panel ? (
        <>
          <Button size="xs" variant="secondary" aria-haspopup="dialog" aria-expanded={panelOpen} title={t('effects.pluginCard.openPanel', 'Open the {name} panel', { name: def.label })} onClick={() => setPanelOpen(true)}>
            {plugin.panelTitle || t('effects.pluginCard.panel', 'Panel')}
          </Button>
          <PluginPanelWindow nodeId={nodeId} effect={effect} def={def} plugin={plugin.id} open={panelOpen} onClose={() => setPanelOpen(false)} />
        </>
      ) : null}
      {def.about ? (
        <Popover
          placement="bottom-end"
          trigger={(
            <IconButton size="sm" aria-label={t('effects.pluginCard.about', 'About {name}', { name: def.label })}>
              <Icon name="info" size="sm" />
            </IconButton>
          )}
        >
          <div className={panel.pluginAbout} role="note">
            <strong>{plugin?.name || def.label}{plugin?.version ? ` ${plugin.version}` : ''}</strong>
            {plugin?.vendor ? <span>{plugin.vendor}</span> : null}
            <p>{def.about}</p>
          </div>
        </Popover>
      ) : null}
    </span>
    </TooltipProvider>
  );
}
