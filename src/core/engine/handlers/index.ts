/** Every edit-command handler, by command type. */

import type { HandlerTable } from '../handler';
import { layerHandlers } from './layers';
import { layerTimeHandlers } from './layerTime';
import { propertyHandlers } from './properties';
import { groupHandlers } from './groups';
import { optionalPropHandlers } from './optionalProps';
import { strokeHandlers } from './strokes';
import { pathHandlers } from './paths';
import { compHandlers } from './comps';
import { itemHandlers } from './items';
import { markerHandlers } from './markers';
import { miscHandlers } from './misc';
import { transitionHandlers } from './transitions';

export const EDIT_HANDLERS: HandlerTable = {
  ...miscHandlers,
  ...itemHandlers,
  ...compHandlers,
  ...layerHandlers,
  ...layerTimeHandlers,
  ...propertyHandlers,
  ...groupHandlers,
  ...optionalPropHandlers,
  ...strokeHandlers,
  ...pathHandlers,
  ...markerHandlers,
  ...transitionHandlers,
};
