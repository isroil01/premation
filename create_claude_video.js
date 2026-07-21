const fs = require('fs');

function makeTransform(id, kind, x, y, rotation = 0, scaleX = 1, scaleY = 1) {
  return {
    id: `${id}_t`,
    type: 'Transform',
    props: {
      __kind: kind,
      x,
      y,
      rotation,
      scaleX,
      scaleY
    }
  };
}

function makeStyle(id, fill, stroke, opacity = 100) {
  return {
    id: `${id}_s`,
    type: 'Style',
    props: {
      opacity,
      fill,
      ...(stroke ? { stroke } : {})
    }
  };
}

function makeText(id, content, fontSize, color, fontFamily = 'Inter') {
  return {
    id: `${id}_c`,
    type: 'Text',
    props: {
      content,
      fontSize,
      opacity: 100,
      color,
      fontFamily
    }
  };
}

function makeGeometry(id, points) {
  return {
    id: `${id}_g`,
    type: 'Geometry',
    props: {
      points
    }
  };
}

const cx = 1920 / 2;
const cy = 1080 / 2;

const nodes = [
  // Master Null to parent everything to
  {
    id: 'master_null',
    name: 'Camera Rig',
    parent: null,
    children: ['bg_group', 'claude_text', 'data_lines_group'],
    transform: { position: { x: cx, y: cy }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      makeTransform('master_null', 'null', cx, cy)
    ]
  },
  // BG Group
  {
    id: 'bg_group',
    name: 'Backgrounds',
    parent: 'master_null',
    children: ['bg_rect', 'glow1', 'glow2'],
    transform: { position: { x: cx, y: cy }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      makeTransform('bg_group', 'group', cx, cy)
    ]
  },
  // Background Rect
  {
    id: 'bg_rect',
    name: 'BG',
    parent: 'bg_group',
    children: [],
    transform: { position: { x: cx, y: cy }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      makeTransform('bg_rect', 'shape', cx, cy),
      makeStyle('bg_rect', '#0f0f13', null),
      { id: 'bg_rect_g', type: 'Geometry', props: { width: 1920, height: 1080 } }
    ]
  },
  // Glow 1
  {
    id: 'glow1',
    name: 'Amber Glow',
    parent: 'bg_group',
    children: [],
    transform: { position: { x: cx, y: cy }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      makeTransform('glow1', 'shape', cx - 300, cy - 200),
      makeStyle('glow1', '#ff9a55', null, 40),
      { id: 'glow1_g', type: 'Geometry', props: { width: 800, height: 800 } },
      { id: 'glow1_b', type: 'blur', props: { radius: 200 } }
    ]
  },
  // Glow 2
  {
    id: 'glow2',
    name: 'Peach Glow',
    parent: 'bg_group',
    children: [],
    transform: { position: { x: cx, y: cy }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      makeTransform('glow2', 'shape', cx + 300, cy + 200),
      makeStyle('glow2', '#ff6b6b', null, 30),
      { id: 'glow2_g', type: 'Geometry', props: { width: 1000, height: 1000 } },
      { id: 'glow2_b', type: 'blur', props: { radius: 250 } }
    ]
  },
  // Claude Text
  {
    id: 'claude_text',
    name: 'Claude AI',
    parent: 'master_null',
    children: [],
    transform: { position: { x: cx, y: cy }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      makeTransform('claude_text', 'text', cx, cy),
      makeText('claude_text', 'Claude', 180, '#ffffff', 'Inter')
    ]
  },
  // Data Lines Group
  {
    id: 'data_lines_group',
    name: 'Data Streams',
    parent: 'master_null',
    children: ['line1', 'line2', 'line3'],
    transform: { position: { x: cx, y: cy }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      makeTransform('data_lines_group', 'group', cx, cy)
    ]
  },
  // Line 1
  {
    id: 'line1',
    name: 'Line 1',
    parent: 'data_lines_group',
    children: [],
    transform: { position: { x: cx, y: cy }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      makeTransform('line1', 'shape', cx, cy),
      makeStyle('line1', '#ffffff', null, 80),
      { id: 'line1_g', type: 'Geometry', props: { width: 400, height: 4 } }
    ]
  },
  // Line 2
  {
    id: 'line2',
    name: 'Line 2',
    parent: 'data_lines_group',
    children: [],
    transform: { position: { x: cx, y: cy }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      makeTransform('line2', 'shape', cx, cy + 100),
      makeStyle('line2', '#ff9a55', null, 100),
      { id: 'line2_g', type: 'Geometry', props: { width: 800, height: 2 } }
    ]
  },
  // Line 3
  {
    id: 'line3',
    name: 'Line 3',
    parent: 'data_lines_group',
    children: [],
    transform: { position: { x: cx, y: cy }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      makeTransform('line3', 'shape', cx, cy - 150),
      makeStyle('line3', '#ff6b6b', null, 60),
      { id: 'line3_g', type: 'Geometry', props: { width: 600, height: 6 } }
    ]
  }
];

// Easing presets
const bezierEaseOut = [0.1, 0.8, 0.2, 1];
const bezierInOut = [0.65, 0, 0.35, 1];

const tracks = {
  // Master Null (Camera zoom)
  'master_null': {
    'scaleX': { nodeId: 'master_null', prop: 'scaleX', keyframes: [
      { t: 0, value: 0.9, easing: 'bezier', bezier: bezierInOut },
      { t: 10, value: 1.1 }
    ]},
    'scaleY': { nodeId: 'master_null', prop: 'scaleY', keyframes: [
      { t: 0, value: 0.9, easing: 'bezier', bezier: bezierInOut },
      { t: 10, value: 1.1 }
    ]}
  },

  // Glow 1 drift
  'glow1': {
    'x': { nodeId: 'glow1', prop: 'x', keyframes: [
      { t: 0, value: cx - 300, easing: 'bezier', bezier: bezierInOut },
      { t: 10, value: cx + 100 }
    ]},
    'y': { nodeId: 'glow1', prop: 'y', keyframes: [
      { t: 0, value: cy - 200, easing: 'bezier', bezier: bezierInOut },
      { t: 10, value: cy + 300 }
    ]}
  },

  // Glow 2 drift
  'glow2': {
    'x': { nodeId: 'glow2', prop: 'x', keyframes: [
      { t: 0, value: cx + 300, easing: 'bezier', bezier: bezierInOut },
      { t: 10, value: cx - 200 }
    ]},
    'y': { nodeId: 'glow2', prop: 'y', keyframes: [
      { t: 0, value: cy + 200, easing: 'bezier', bezier: bezierInOut },
      { t: 10, value: cy - 100 }
    ]}
  },

  // Claude Text reveal
  'claude_text': {
    'y': { nodeId: 'claude_text', prop: 'y', keyframes: [
      { t: 1, value: cy + 100, easing: 'bezier', bezier: bezierEaseOut },
      { t: 3, value: cy }
    ]},
    'opacity': { nodeId: 'claude_text', prop: 'opacity', keyframes: [
      { t: 1, value: 0, easing: 'linear' },
      { t: 2, value: 100 }
    ]},
    'scaleX': { nodeId: 'claude_text', prop: 'scaleX', keyframes: [
      { t: 1, value: 0.8, easing: 'bezier', bezier: bezierEaseOut },
      { t: 3, value: 1 }
    ]},
    'scaleY': { nodeId: 'claude_text', prop: 'scaleY', keyframes: [
      { t: 1, value: 0.8, easing: 'bezier', bezier: bezierEaseOut },
      { t: 3, value: 1 }
    ]},
    // Elastic overshoot rotation
    'rotation': { nodeId: 'claude_text', prop: 'rotation', keyframes: [
      { t: 1, value: -10, easing: 'bezier', bezier: bezierEaseOut },
      { t: 2, value: 5, easing: 'bezier', bezier: bezierEaseOut },
      { t: 2.5, value: -2, easing: 'bezier', bezier: bezierEaseOut },
      { t: 3, value: 0 }
    ]}
  },

  // Line 1 shoot
  'line1': {
    'x': { nodeId: 'line1', prop: 'x', keyframes: [
      { t: 3, value: -400, easing: 'bezier', bezier: bezierEaseOut },
      { t: 4, value: 2400 }
    ]},
    'opacity': { nodeId: 'line1', prop: 'opacity', keyframes: [
      { t: 3, value: 100 },
      { t: 3.8, value: 100 },
      { t: 4, value: 0 }
    ]}
  },

  // Line 2 shoot
  'line2': {
    'x': { nodeId: 'line2', prop: 'x', keyframes: [
      { t: 3.5, value: 2400, easing: 'bezier', bezier: bezierEaseOut },
      { t: 4.5, value: -800 }
    ]},
    'opacity': { nodeId: 'line2', prop: 'opacity', keyframes: [
      { t: 3.5, value: 100 },
      { t: 4.3, value: 100 },
      { t: 4.5, value: 0 }
    ]}
  },

  // Line 3 shoot
  'line3': {
    'x': { nodeId: 'line3', prop: 'x', keyframes: [
      { t: 4, value: -600, easing: 'bezier', bezier: bezierEaseOut },
      { t: 5, value: 2600 }
    ]},
    'opacity': { nodeId: 'line3', prop: 'opacity', keyframes: [
      { t: 4, value: 100 },
      { t: 4.8, value: 100 },
      { t: 5, value: 0 }
    ]}
  }
};

const document = {
  version: "1.0.0",
  scene: {
    version: "1.0.0",
    nodes
  },
  animation: {
    tracks,
    expressions: {}
  },
  comp: {
    width: 1920,
    height: 1080,
    fps: 60,
    duration: 10,
    backgroundColor: "#0f0f13"
  }
};

fs.writeFileSync('claude_ai_video.json', JSON.stringify(document, null, 2));
console.log('Successfully generated claude_ai_video.json');
