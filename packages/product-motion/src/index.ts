/**
 * @motion/product-motion — UI/UX motion as its own discipline.
 *
 * Springs, not beziers. 200–300ms, not 400–900. Exits faster than entrances.
 * 8–24px of travel. Shared-element transitions instead of cuts. No motion blur,
 * ever. These are not preferences — they are the rules that make output read as
 * a real product rather than as a title sequence applied to a card, and several
 * of them directly contradict the editorial library's.
 *
 * Pure. Emits `ToolCall[]`, executes nothing.
 */

export {
  BUDGETS,
  UI_LIMITS,
  allowsMotionBlur,
  budgetFor,
  listStagger,
  listStaggerAt,
  type Budget,
  type UiElementClass,
} from './choreography';

export {
  magicMove,
  sharedElementOpportunities,
  type MagicMoveOptions,
  type MagicMoveResult,
  type UiElement,
  type UiState,
} from './shared-element';

export {
  clickIndicator,
  cursorPath,
  momentumScroll,
  pointerDuration,
  type CursorPathOptions,
  type CursorPathResult,
  type Point,
} from './cursor';

export {
  UI_COMPONENTS,
  componentAllows,
  uiComponent,
  type ComponentBox,
  type ComponentContext,
  type ComponentState,
  type GridBehaviour,
  type UiComponentDef,
} from './components';

export { PRODUCT_TECHNIQUES } from './techniques';

export {
  formatUiFindings,
  lintUiMotion,
  uiMotionScore,
  type Severity,
  type UiFinding,
  type UiLintScene,
  type UiRule,
} from './lint';
