import { FAMILY_CORPUS, GENERATED_CORPUS } from '../__testHelpers__/corpus';
import { setupEngine } from '../__testHelpers__/harness';
jest.useFakeTimers();
test('wsr session runs on TS', async () => {
  const h = await setupEngine();
  await FAMILY_CORPUS['B3z WS-R: puppet pins and skeletons — groups, pin keys, bones, IK, pole, bind pose — save → open']!(h);
  await h.dispose();
});
test.each(Object.keys(GENERATED_CORPUS).slice(0, 12))('gen %s', async (n) => {
  const h = await setupEngine();
  await GENERATED_CORPUS[n]!(h);
  await h.dispose();
});
