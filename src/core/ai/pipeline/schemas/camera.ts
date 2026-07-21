import type { JsonSchema } from '@motion/ai-tools';

export const cameraSchema: JsonSchema = {
  type: 'object',
  properties: {
    beatId: {
      type: 'string',
      description: 'The unique storyboard beat ID this camera plan belongs to.',
    },
    cameraMoves: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          framing: {
            type: 'string',
            description: 'Framing composition, e.g. "Medium shot centered", "Foreground parallax split".',
          },
          cameraMovementType: {
            type: 'string',
            enum: ['push_in', 'pull_out', 'pan', 'tilt', 'orbit', 'dolly', 'static'],
            description: 'The standard active camera movement category.',
          },
          zoomDollyOrbitParallaxIntent: {
            type: 'string',
            description: 'Detailed mechanical movement explanation.',
          },
          lensFeel: {
            type: 'string',
            description: 'Focal length or view angles, e.g., "50mm prime style", "wide angle dynamic view".',
          },
          depthOfFieldIntent: {
            type: 'string',
            description: 'Aperture blur highlights, e.g. "Shallow depth of field focus on hero_title".',
          },
          startTimeSeconds: {
            type: 'number',
            description: 'Relative start time of the move in seconds from scene start.',
          },
          durationSeconds: {
            type: 'number',
            description: 'The duration of the camera move in seconds.',
          },
        },
        required: [
          'framing',
          'cameraMovementType',
          'zoomDollyOrbitParallaxIntent',
          'lensFeel',
          'depthOfFieldIntent',
          'startTimeSeconds',
          'durationSeconds',
        ],
      },
      description: 'cinematic camera layers and move properties.',
    },
  },
  required: ['beatId', 'cameraMoves'],
};
