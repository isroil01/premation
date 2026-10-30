/**
 * Settings ▸ Performance Recording (docs/PERFORMANCE_ANIMATION_PLAN.md §9):
 * how Motion Sketch / Perform takes become keys, and Pose mode's step.
 *
 * The same preferences the Performance bar's ⋯ popover changes — two views of
 * one setting, never two settings. The reduction keeps today's behaviours as
 * choices: After Effects' one key per sample and the earlier path smoothing.
 * Then hand tracking (P1): the model install and a camera test.
 */

import { Segmented } from '@components/Segmented';
import { Slider } from '@components/Slider';
import { Switch } from '@components/Switch';
import { usePreferenceStore } from '@stores/preferenceStore';
import { t } from '@core/i18n';
import { cn } from '@utils/cn';
import styles from './CustomizeDialog.module.css';
import { CameraTestControl, HandModelControl, useHandModelInstalled } from './HandTrackingControls';

export function PerformanceSettingsSection(): JSX.Element {
  const reduction = usePreferenceStore((s) => s.performanceReduction);
  const detail = usePreferenceStore((s) => s.performanceDetail);
  const wholeFrames = usePreferenceStore((s) => s.performanceWholeFrames);
  const speed = usePreferenceStore((s) => s.performanceCaptureSpeed);
  const preRoll = usePreferenceStore((s) => s.performancePreRoll);
  const hold = usePreferenceStore((s) => s.performanceHoldSeconds);
  const step = usePreferenceStore((s) => s.performancePoseStep);
  const stepUnit = usePreferenceStore((s) => s.performancePoseStepUnit);
  const handGain = usePreferenceStore((s) => s.performanceHandGain);
  const whichHand = usePreferenceStore((s) => s.performanceHand);
  const handMirror = usePreferenceStore((s) => s.performanceHandMirror);
  const setPref = usePreferenceStore((s) => s.set);
  const smart = reduction === 'smart';
  const [handModel, setHandModel] = useHandModelInstalled();

  return (
    <div className={styles.sectionGroup}>
      <div className={styles.sectionHeading}>
        <span className={styles.sectionTitle}>{t('settings.performance.title', 'Motion recording')}</span>
        <span className={styles.hint}>{t('settings.performance.hint', 'How a recorded take becomes keyframes.')}</span>
      </div>

      <div className={styles.settingCard}>
        <div className={cn(styles.settingRow, styles.settingRowWide)}>
          <div className={styles.settingInfo}>
            <span className={styles.settingTitle}>{t('settings.performance.reduction', 'Keyframe reduction')}</span>
            <span className={styles.settingDesc}>
              {smart
                ? t('performance.reduction.smartHelp', 'Few keys with eases and path handles; pauses stay pauses.')
                : reduction === 'everyFrame'
                  ? t('performance.reduction.everyFrameHelp', 'One key per captured sample — After Effects’ Motion Sketch.')
                  : t('performance.reduction.smoothHelp', 'Simplifies the drawn path; pauses along a straight line are not kept.')}
            </span>
          </div>
          <div className={styles.settingRight}>
            <Segmented
              size="sm"
              value={reduction}
              onChange={(v) => setPref('performanceReduction', v)}
              options={[
                { value: 'smart', label: t('performance.reduction.smart', 'Smart') },
                { value: 'everyFrame', label: t('performance.reduction.everyFrame', 'Every frame') },
                { value: 'smooth', label: t('performance.reduction.smooth', 'Smooth') },
              ]}
            />
          </div>
        </div>

        <div className={styles.settingRow}>
          <div className={styles.settingInfo}>
            <span className={styles.settingTitle}>{t('performance.detail', 'Detail')}</span>
            <span className={styles.settingDesc}>{t('settings.performance.detailDesc', 'Fewer keys, or a closer match.')}</span>
          </div>
          <div className={styles.settingRight}>
            <Slider size="sm" min={0} max={100} step={1} value={detail} disabled={!smart} showValue onChange={(v) => setPref('performanceDetail', v)} />
          </div>
        </div>

        <div className={styles.switchRow}>
          <div className={styles.settingInfo}>
            <span className={styles.settingTitle}>{t('performance.wholeFrames', 'Keys on whole frames')}</span>
            <span className={styles.settingDesc}>{t('settings.performance.wholeFramesDesc', 'Snap every key to a frame.')}</span>
          </div>
          <Switch
            checked={wholeFrames}
            disabled={!smart}
            onChange={(e) => setPref('performanceWholeFrames', e.target.checked)}
            aria-label={t('performance.wholeFrames', 'Keys on whole frames')}
          />
        </div>

        <div className={styles.settingRow}>
          <div className={styles.settingInfo}>
            <span className={styles.settingTitle}>{t('settings.performance.speed', 'Capture speed')}</span>
            <span className={styles.settingDesc}>{t('performance.speedHelp', 'Capture speed: 50% plays back twice as long as you drew it')}</span>
          </div>
          <div className={styles.settingRight}>
            <Segmented
              size="sm"
              value={String(speed) as '25' | '50' | '100' | '200'}
              onChange={(v) => setPref('performanceCaptureSpeed', Number(v))}
              options={[25, 50, 100, 200].map((n) => ({ value: String(n) as '25' | '50' | '100' | '200', label: `${n}%` }))}
            />
          </div>
        </div>

        <div className={styles.settingRow}>
          <div className={styles.settingInfo}>
            <span className={styles.settingTitle}>{t('performance.preRoll', 'Pre-roll')}</span>
            <span className={styles.settingDesc}>{t('settings.performance.preRollDesc', 'Playback starts this long before the take.')}</span>
          </div>
          <div className={styles.settingRight}>
            <Segmented
              size="sm"
              value={String(preRoll) as '0' | '1' | '2'}
              onChange={(v) => setPref('performancePreRoll', Number(v))}
              options={[
                { value: '0', label: t('performance.preRoll.off', 'Off') },
                { value: '1', label: '1 s' },
                { value: '2', label: '2 s' },
              ]}
            />
          </div>
        </div>

        <div className={styles.settingRow}>
          <div className={styles.settingInfo}>
            <span className={styles.settingTitle}>{t('performance.hold', 'Hold after')}</span>
            <span className={styles.settingDesc}>{t('settings.performance.holdDesc', 'Stillness this long (s) becomes a hold.')}</span>
          </div>
          <div className={styles.settingRight}>
            <Slider size="sm" min={0.1} max={1} step={0.05} value={hold} disabled={!smart} showValue onChange={(v) => setPref('performanceHoldSeconds', v)} />
          </div>
        </div>

        <div className={styles.settingRow}>
          <div className={styles.settingInfo}>
            <span className={styles.settingTitle}>{t('settings.performance.poseStep', 'Pose step')}</span>
            <span className={styles.settingDesc}>{t('performance.stepHelp', 'How far the playhead moves after each key')}</span>
          </div>
          <div className={styles.settingRight}>
            <Slider
              size="sm"
              min={stepUnit === 'seconds' ? 0.1 : 1}
              max={stepUnit === 'seconds' ? 5 : 60}
              step={stepUnit === 'seconds' ? 0.1 : 1}
              value={step}
              showValue
              onChange={(v) => setPref('performancePoseStep', v)}
            />
            <Segmented
              size="sm"
              value={stepUnit}
              onChange={(v) => {
                setPref('performancePoseStepUnit', v);
                setPref('performancePoseStep', v === 'seconds' ? 1 : 10);
              }}
              options={[
                { value: 'frames', label: t('settings.performance.frames', 'Frames') },
                { value: 'seconds', label: t('settings.performance.seconds', 'Seconds') },
              ]}
            />
          </div>
        </div>

        <div className={cn(styles.settingRow, styles.settingRowWide)}>
          <div className={styles.settingInfo}>
            <span className={styles.settingTitle}>{t('settings.handModel.title', 'Hand tracking')}</span>
            <span className={styles.settingDesc}>{t('settings.handModel.desc', 'Drive animation with your hand through the camera.')}</span>
          </div>
          <div className={styles.settingRight}>
            <HandModelControl onChange={setHandModel} />
          </div>
        </div>

        {handModel ? (
          <>
            <div className={styles.settingRow}>
              <div className={styles.settingInfo}>
                <span className={styles.settingTitle}>{t('performance.hand.gain', 'Hand gain')}</span>
                <span className={styles.settingDesc}>{t('settings.performance.handGainDesc', 'At 1, crossing the camera crosses the composition.')}</span>
              </div>
              <div className={styles.settingRight}>
                <Slider size="sm" min={0.25} max={4} step={0.25} value={handGain} showValue onChange={(v) => setPref('performanceHandGain', v)} />
              </div>
            </div>
            <div className={styles.settingRow}>
              <div className={styles.settingInfo}>
                <span className={styles.settingTitle}>{t('performance.hand.which', 'Hand')}</span>
                <span className={styles.settingDesc}>{t('settings.performance.handDesc', 'Either follows the nearer hand.')}</span>
              </div>
              <div className={styles.settingRight}>
                <Segmented
                  size="sm"
                  value={whichHand}
                  onChange={(v) => setPref('performanceHand', v)}
                  options={[
                    { value: 'either', label: t('performance.hand.either', 'Either') },
                    { value: 'left', label: t('performance.hand.left', 'Left') },
                    { value: 'right', label: t('performance.hand.right', 'Right') },
                  ]}
                />
              </div>
            </div>
            <div className={styles.switchRow}>
              <div className={styles.settingInfo}>
                <span className={styles.settingTitle}>{t('performance.hand.mirror', 'Mirror')}</span>
                <span className={styles.settingDesc}>{t('settings.performance.handMirrorDesc', 'Right in front of the camera is right on screen.')}</span>
              </div>
              <Switch
                checked={handMirror}
                onChange={(e) => setPref('performanceHandMirror', e.target.checked)}
                aria-label={t('performance.hand.mirror', 'Mirror')}
              />
            </div>
          <div className={cn(styles.settingRow, styles.settingRowWide)}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>{t('settings.cameraTest.title', 'Camera test')}</span>
              <span className={styles.settingDesc}>{t('settings.cameraTest.desc', 'The camera turns off when you leave this page.')}</span>
            </div>
            <div className={styles.settingRight}>
              <CameraTestControl />
            </div>
          </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
