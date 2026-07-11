import { propertyRegistry } from './PropertyRegistry';

describe('PropertyRegistry', () => {
  beforeEach(() => {
    // Full reset for test isolation — the registry is a shared singleton.
    propertyRegistry.clear();
  });

  test('register and retrieve exact match', () => {
    const renderA = () => null;
    propertyRegistry.register('comp', 'prop', renderA);
    const got = propertyRegistry.get('comp', 'prop');
    expect(got).toBe(renderA);
  });

  test('wildcard precedence', () => {
    const anyAny = () => null;
    const compAny = () => null;
    const anyProp = () => null;
    propertyRegistry.register('*', '*', anyAny);
    propertyRegistry.register('comp', '*', compAny);
    propertyRegistry.register('*', 'prop', anyProp);
    // exact not present -> comp.* should take precedence over *.prop
    const got = propertyRegistry.get('comp', 'prop');
    expect(got).toBe(compAny);
  });
});
