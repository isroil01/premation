/**
 * The two pieces of Effect-Controls behaviour that are logic rather than layout:
 * how a stack names two of a kind, and what Reset actually restores.
 *
 * Both were read off a screenshot of After Effects, and both are the kind of
 * rule that looks obviously right and is easy to get subtly wrong — numbering
 * from zero, numbering the first instance, resetting the wrong effect in the
 * stack, or leaving the legacy `amount` behind so a "reset" effect keeps the
 * look it had.
 */

import {
  EFFECT_DEFS,
  
  
  effectDisplayNames,
  
  
  
  
  
  type Effect,
} from './effects';

const defOf = (type: string) => EFFECT_DEFS.find((d) => d.type === type)!;

beforeEach(() => {
});

describe('effectDisplayNames — AE numbering', () => {
  const named = (types: string[]): string[] => {
    const effects = types.map((type, i) => ({ id: `e${i}`, type }) as Effect);
    const names = effectDisplayNames(effects);
    return effects.map((e) => names.get(e.id)!);
  };

  it('leaves a lone effect unnumbered', () => {
    expect(named(['blur'])).toEqual([defOf('blur').label]);
  });

  it('numbers from the SECOND of a kind, not the first', () => {
    const label = defOf('blur').label;
    // AE reads "CC Smear / CC Smear 2 / CC Smear 3 / CC Smear 4" — the first
    // keeps its plain name. Numbering all four would be the easy mistake.
    expect(named(['blur', 'blur', 'blur', 'blur'])).toEqual([
      label, `${label} 2`, `${label} 3`, `${label} 4`,
    ]);
  });

  it('counts each type independently, in stack order', () => {
    const blur = defOf('blur').label;
    const glow = defOf('glow').label;
    expect(named(['blur', 'glow', 'blur', 'glow'])).toEqual([
      blur, glow, `${blur} 2`, `${glow} 2`,
    ]);
  });
});
