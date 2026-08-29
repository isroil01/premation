import { EventBus, getEventBus, setEventBus } from '@core/events/EventBus';
import { attachRenderBackendEvents, useRenderBackendStore } from './renderBackendStore';

beforeEach(() => {
  setEventBus(new EventBus());
  useRenderBackendStore.setState({ activeTier: 'pending', isSoftwareFallback: false });
});

it('binds to the active post-boot event bus and ignores auxiliary renderers', () => {
  const dispose = attachRenderBackendEvents();

  getEventBus().emit('EngineReady', { engine: 'motion-webgpu', role: 'auxiliary' });
  expect(useRenderBackendStore.getState().activeTier).toBe('pending');

  getEventBus().emit('EngineReady', { engine: 'motion-webgpu', role: 'viewport' });
  expect(useRenderBackendStore.getState().activeTier).toBe('webgpu');

  dispose();
});

it('disposes both renderer event subscriptions', () => {
  const dispose = attachRenderBackendEvents();
  expect(getEventBus().listenerCount('EngineReady')).toBe(1);
  expect(getEventBus().listenerCount('EngineError')).toBe(1);

  dispose();

  expect(getEventBus().listenerCount('EngineReady')).toBe(0);
  expect(getEventBus().listenerCount('EngineError')).toBe(0);
});
