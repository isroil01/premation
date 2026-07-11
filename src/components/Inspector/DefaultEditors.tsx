import { propertyRegistry } from '@core/inspector/PropertyRegistry';
import { Input } from '@components/Input';
import { Switch } from '@components/Switch/Switch';
import { ValueField } from '@components/ValueField';
import { ColorPicker } from '@components/ColorPicker';

/**
 * Default property editors.
 *
 * Every numeric property routes through the signature <ValueField> (scrub +
 * type + math + modifier keys). Non-numeric fall back to text/boolean inputs.
 * Register more specific editors per component::prop to override these.
 */
export function registerDefaultEditors(): void {
  // Fallback editor for any property based on JS typeof.
  propertyRegistry.register('*', '*', ({ value, onChange }) => {
    const t = typeof value;
    if (t === 'number') {
      return <ValueField value={Number(value) || 0} onChange={(v) => onChange(v)} />;
    }
    if (t === 'boolean') {
      return (
        <Switch checked={Boolean(value)} onChange={(e) => onChange(e.currentTarget.checked)} />
      );
    }
    // default to string input
    return (
      <Input value={String(value ?? '')} onChange={(e) => onChange(e.currentTarget.value)} />
    );
  });

  // Opacity: 0–100 %.
  propertyRegistry.register('*', 'opacity', ({ value, onChange }) => (
    <ValueField
      value={Number(value) || 0}
      onChange={(v) => onChange(v)}
      min={0}
      max={100}
      unit="%"
      precision={0}
      aria-label="opacity"
    />
  ));

  // Rotation: degrees, unclamped.
  propertyRegistry.register('*', 'rotation', ({ value, onChange }) => (
    <ValueField
      value={Number(value) || 0}
      onChange={(v) => onChange(v)}
      unit="°"
      precision={1}
      aria-label="rotation"
    />
  ));

  // Color properties → real color picker (swatch + popover).
  const colorEditor = ({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) => (
    <ColorPicker value={String(value ?? '#000000')} onChange={(hex) => onChange(hex)} aria-label="color" />
  );
  propertyRegistry.register('*', 'fill', colorEditor);
  propertyRegistry.register('*', 'color', colorEditor);
  propertyRegistry.register('*', 'stroke', colorEditor);
  propertyRegistry.register('*', 'background', colorEditor);
}

export default registerDefaultEditors;
