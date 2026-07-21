import { useState, useMemo } from 'react';
import { Panel } from '@components/Panel';
import { Accordion, type AccordionItem } from '@components/Accordion';
import { Input } from '@components/Input';
import { Icon } from '@components/Icon';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { listPresets, applyPresetByName, deletePreset } from '@core/animation/animationPresets';
import { useSelectionStore } from '@stores/selectionStore';
import { useWorkspaceStore } from '@stores/projectStore';
import { useUIStore } from '@stores/uiStore';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import { setCanvasDrag } from '@core/dnd/canvasDrag';
import { getEventBus } from '@core/events/EventBus';
import styles from './MotionPresetsPanel.module.css';

const PRESET_DESCRIPTIONS: Record<string, string> = {
  'Fade In': 'Gradually fade opacity from 0% to 100%.',
  'Fade Out': 'Gradually fade opacity from 100% to 0%.',
  'Pop In': 'Scale up with a bouncing animation.',
  'Spin': 'Rotate 360 degrees around the anchor point.',
  'Pulse': 'Gently grow and shrink in scale.',
  'Bounce In': 'Elastic scaling entry from zero.',
  'Slide In Left': 'Slide into view from the left side.',
  'Slide In Right': 'Slide into view from the right side.',
  'Rise Up': 'Slide up into view from below.',
  'Drop In': 'Drop down from above with a rebound bounce.',
  'Shake': 'Rapid rotation oscillations for emphasis.',
  'Flip In 3D': 'Smooth entry flip around the 3D Y-axis.',
  'Card Flip 3D': 'Rotate 180 degrees around the Y-axis.',
  'Swing In 3D': 'Pendulum-like swing from the top axis.',
  'Depth Push In': 'Push forward from deep Z space.',
  'Orbit Tilt 3D': 'Orbit around multiple axes simultaneously.',
  'Spiral Entrance': 'Spin and scale up from center with overshoot.',
  'Skid Slide In': 'Slide in fast, skid overshoot, and slide back.',
  'Zoom Out Exit': 'Slight scale pop and zoom out to 0% scale.',
  'Rotate Out Exit': 'Spin rotation while scaling down to 0%.',
  'Heartbeat': 'Scale up and down in a rhythmic double-pulse.',
  'Elastic Float': 'Continuous smooth vertical floating movement.',
  'Jelly Wobble': 'Continuous scale stretch, squash, and tilt wobble.',
  'Glitch Jitter': 'High-frequency micro-movements on position and scale.',
  'Wiggle Drift': 'Apply position expression for continuous organic noise drift.',
  'Wind Sway': 'Apply rotation expression for continuous pendulum-like sway.',
  '3D Twirl In': 'Spin X and Y axes while scaling up into view.',
  '3D Cube Roll': '3D roll rotation towards camera from Z space.',
  'Cinematic Pan 3D': 'Gentle 3D parallax rotation and depth panning.',
  'Typewriter': 'Reveal characters one-by-one from left to right.',
  'Bounce In Words': 'Bounce text words in one-by-one from top.',
  'Spin & Fade Characters': 'Spin text characters in one-by-one.',
  'Tracking Reveal': 'Expand character tracking space while fading in.',
};

type SortOrder = 'default' | 'alphabetical-asc' | 'alphabetical-desc';

export function MotionPresetsPanel(): JSX.Element {
  const selectedIds = useSelectionStore((s) => s.ids);
  const notify = useUIStore((s) => s.notify);
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  const playhead = useWorkspaceStore((s) => (activeTabId ? s.tabs[activeTabId]?.time : 0) ?? 0);
  
  // Re-render when the scene is modified (e.g. user saves or deletes a preset)
  const sceneRev = useSceneRevision((s) => s.rev);

  const [search, setSearch] = useState('');
  const [sortOrder, setSortOrder] = useState<SortOrder>('default');

  const presets = useMemo(() => {
    return listPresets();
    // sceneRev is the refresh signal: save/delete bumps the scene revision.
  }, [sceneRev]);

  // Filtered and sorted presets
  const processedPresets = useMemo(() => {
    let result = [...presets];

    // Search filter
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (PRESET_DESCRIPTIONS[p.name] || '').toLowerCase().includes(q) ||
          (p.category || '').toLowerCase().includes(q)
      );
    }

    // Sort order
    if (sortOrder === 'alphabetical-asc') {
      result.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortOrder === 'alphabetical-desc') {
      result.sort((a, b) => b.name.localeCompare(a.name));
    }

    return result;
  }, [presets, search, sortOrder]);

  // Group by category
  const categories = useMemo(() => {
    const groups: Record<string, typeof processedPresets> = {
      'Entrances': [],
      'Exits': [],
      '3D Motions': [],
      'Text Animators (AE-Style)': [],
      'Emphases & Loops': [],
      'Saved Presets': [],
    };

    processedPresets.forEach((p) => {
      const cat = p.builtin ? p.category || 'Emphases & Loops' : 'Saved Presets';
      if (!groups[cat]) {
        groups[cat] = [];
      }
      groups[cat]!.push(p);
    });

    return groups;
  }, [processedPresets]);

  const handleApplyPreset = (presetName: string) => {
    if (selectedIds[0]) {
      const ok = applyPresetByName(selectedIds[0], presetName, playhead);
      if (ok) {
        notify({ level: 'success', message: `Applied "${presetName}"`, durationMs: 2000 });
      } else {
        notify({ level: 'warning', message: `Failed to apply "${presetName}"`, durationMs: 2000 });
      }
    } else {
      notify({ level: 'warning', message: 'Select a layer first', durationMs: 2000 });
    }
  };

  const getEnvironment = (classKey: string) => {
    if (classKey.includes('fade')) {
      return (
        <div className={styles.envFade}>
          <div className={styles.envGrid} />
        </div>
      );
    }
    if (classKey.includes('spin') || classKey.includes('orbit') || classKey.includes('spiral') || classKey.includes('rotate') || classKey.includes('sway')) {
      return (
        <div className={styles.envSpin}>
          <div className={styles.envOrbitRing} />
        </div>
      );
    }
    if (classKey.includes('pulse') || classKey.includes('heartbeat')) {
      return (
        <div className={styles.envPulse}>
          <div className={styles.envPulseRing1} />
          <div className={styles.envPulseRing2} />
        </div>
      );
    }
    if (classKey.includes('pop') || classKey.includes('bounce') || classKey.includes('zoom')) {
      return (
        <div className={styles.envPop}>
          <div className={styles.envSparkle} style={{ top: 6, left: 6 }} />
          <div className={styles.envSparkle} style={{ bottom: 6, right: 6 }} />
        </div>
      );
    }
    if (classKey.includes('slide') || classKey.includes('skid') || classKey.includes('typewriter') || classKey.includes('reveal') || classKey.includes('characters') || classKey.includes('words')) {
      return (
        <div className={styles.envSlide}>
          <div className={styles.envTrackLine} />
        </div>
      );
    }
    if (classKey.includes('rise') || classKey.includes('drop') || classKey.includes('float')) {
      return (
        <div className={styles.envVertical}>
          <div className={styles.envTrackLineVertical} />
          <div className={styles.envGroundLine} />
        </div>
      );
    }
    if (classKey.includes('shake') || classKey.includes('glitch') || classKey.includes('jitter') || classKey.includes('jelly') || classKey.includes('wobble')) {
      return (
        <div className={styles.envShake}>
          <div className={styles.envBoundLeft} />
          <div className={styles.envBoundRight} />
        </div>
      );
    }
    if (classKey.includes('3d') || classKey.includes('cube') || classKey.includes('pan') || classKey.includes('swing') || classKey.includes('depth') || classKey.includes('flip')) {
      return (
        <div className={styles.envThreeD}>
          <div className={styles.envGrid3D} />
        </div>
      );
    }
    return <div className={styles.envDefault} />;
  };

  const sortItems: DropdownItem[] = [
    { type: 'label', label: 'Sort Presets By' },
    {
      type: 'checkbox',
      id: 'default',
      label: 'Default Order',
      checked: sortOrder === 'default',
      onChange: () => setSortOrder('default'),
    },
    {
      type: 'checkbox',
      id: 'asc',
      label: 'Alphabetical (A-Z)',
      checked: sortOrder === 'alphabetical-asc',
      onChange: () => setSortOrder('alphabetical-asc'),
    },
    {
      type: 'checkbox',
      id: 'desc',
      label: 'Alphabetical (Z-A)',
      checked: sortOrder === 'alphabetical-desc',
      onChange: () => setSortOrder('alphabetical-desc'),
    },
  ];

  const accordionItems = useMemo((): AccordionItem[] => {
    return Object.entries(categories)
      .filter(([_, items]) => items.length > 0)
      .map(([cat, items]) => {
        return {
          id: cat,
          title: cat,
          badge: <span className={styles.catBadge}>{items.length}</span>,
          defaultOpen: cat === 'Entrances' || cat === 'Saved Presets',
          content: (
            <div className={styles.presetGrid}>
              {items.map((preset) => {
                const classKey = preset.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
                
                // Determine visual preview element: dot, animating text spans, or 3D cards
                let previewElement = <div className={`${styles.presetDot} ${styles[classKey] || ''}`} />;
                if (cat === 'Text Animators (AE-Style)' || preset.name === 'Typewriter' || preset.name === 'Bounce In Words' || preset.name === 'Spin & Fade Characters' || preset.name === 'Tracking Reveal') {
                  const characters = ['A', 'e', 'f', 'x'];
                  previewElement = (
                    <div className={`${styles.textPreviewWrapper} ${styles[classKey] || ''}`}>
                      {characters.map((char, index) => (
                        <span key={index} style={{ animationDelay: `${index * 120}ms` }}>{char}</span>
                      ))}
                    </div>
                  );
                } else if (cat === '3D Motions' || classKey.includes('3d') || classKey.includes('depth') || classKey.includes('cube') || classKey.includes('flip')) {
                  previewElement = (
                    <div className={`${styles.threeDPreviewWrapper} ${styles[classKey] || ''}`}>
                      <div className={styles.threeDPlaneFace}>3D</div>
                    </div>
                  );
                }

                return (
                  <div key={preset.name} className={styles.presetCardWrapper}>
                    <button
                      type="button"
                      className={styles.presetCard}
                      title={`Apply: ${preset.name} — or drag onto a layer`}
                      draggable
                      onDragStart={(e) => setCanvasDrag(e, { kind: 'motionPreset', name: preset.name })}
                      onClick={() => handleApplyPreset(preset.name)}
                    >
                      <div className={styles.presetPreview}>
                        {getEnvironment(classKey)}
                        {previewElement}
                      </div>
                      <div className={styles.presetInfo}>
                        <span className={styles.presetName}>{preset.name}</span>
                        <span className={styles.presetDesc}>
                          {PRESET_DESCRIPTIONS[preset.name] || 'Custom user motion preset.'}
                        </span>
                      </div>
                    </button>
                    {!preset.builtin ? (
                      <button
                        type="button"
                        className={styles.deleteBtn}
                        title="Delete custom preset"
                        onClick={(e) => {
                          e.stopPropagation();
                          deletePreset(preset.name);
                          notify({ level: 'success', message: `Deleted preset "${preset.name}"`, durationMs: 2000 });
                          // 'SceneChanged' is not an EventBus event — the panel
                          // refreshes off the scene revision.
                          bumpScene();
                        }}
                      >
                        <Icon name="trash" size={12} />
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ),
        };
      });
  }, [categories, selectedIds, playhead]);

  return (
    <Panel
      id="presets"
      title="Presets"
      icon="zap"
      hideHeader
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'presets' })}
    >
      <div className={styles.panelHeader}>
        <div className={styles.searchRow}>
          <div className={styles.searchInputWrapper}>
            <Icon name="search" size={12} className={styles.searchIcon} />
            <Input
              value={search}
              placeholder="Search presets..."
              className={styles.searchInput}
              onChange={(e) => setSearch(e.currentTarget.value)}
            />
            {search ? (
              <button
                type="button"
                className={styles.clearSearchBtn}
                onClick={() => setSearch('')}
              >
                <Icon name="close" size={11} />
              </button>
            ) : null}
          </div>
          <Dropdown
            placement="bottom-end"
            trigger={
              <button type="button" className={styles.sortBtn} title="Sort presets">
                <Icon name="settings" size={12} />
              </button>
            }
            items={sortItems}
          />
        </div>
      </div>
      <div className={styles.libBody}>
        {accordionItems.length > 0 ? (
          <Accordion items={accordionItems} />
        ) : (
          <div className={styles.emptyState}>
            <Icon name="sparkles" size={16} className={styles.emptyIcon} />
            <span className={styles.emptyText}>No presets found for "{search}"</span>
          </div>
        )}
      </div>
    </Panel>
  );
}

export default MotionPresetsPanel;
