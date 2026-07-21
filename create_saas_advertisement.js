const fs = require('fs');
const path = require('path');

// Generate short IDs
const shortId = () => Math.random().toString(36).substring(2, 8);

// Helper to create a component
function createComponent(type, props) {
    return {
        id: `${type}_${shortId()}`,
        type,
        props
    };
}

// Generate base transform component
function tComponent(props = {}) {
    return createComponent('Transform', Object.assign({
        x: 1920/2,
        y: 1080/2,
        rotation: 0,
        scaleX: 1,
        scaleY: 1
    }, props));
}

// Generate a shape node
function createShape(name, transformProps, styleProps, parent = null) {
    const id = `node_${shortId()}`;
    return {
        id,
        name,
        parent,
        children: [],
        transform: { position: { x: transformProps.x || 0, y: transformProps.y || 0 }, rotation: 0, scale: { x: 1, y: 1 } },
        visible: true,
        locked: false,
        components: [
            tComponent(Object.assign({ shapeType: 'rect' }, transformProps)),
            createComponent('Style', Object.assign({ fill: '#ffffff', opacity: 100 }, styleProps))
        ]
    };
}

// Generate a text node
function createText(name, content, transformProps, textProps, parent = null) {
    const id = `node_${shortId()}`;
    return {
        id,
        name,
        parent,
        children: [],
        transform: { position: { x: transformProps.x || 0, y: transformProps.y || 0 }, rotation: 0, scale: { x: 1, y: 1 } },
        visible: true,
        locked: false,
        components: [
            tComponent(Object.assign({ shapeType: 'text' }, transformProps)),
            createComponent('Text', Object.assign({ content, fontSize: 48, fill: '#ffffff' }, textProps))
        ]
    };
}

// Group/Precomp node
function createGroup(name, parent = null, isPrecomp = false) {
    const id = `group_${shortId()}`;
    return {
        id,
        name,
        parent,
        children: [],
        transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
        visible: true,
        locked: false,
        components: [
            createComponent('group', { group: 'group', precomp: isPrecomp })
        ]
    };
}

// Camera node
function createCamera() {
    const id = `camera_${shortId()}`;
    return {
        id,
        name: 'Main Camera',
        parent: null,
        children: [],
        transform: { position: { x: 1920/2, y: 1080/2 }, rotation: 0, scale: { x: 1, y: 1 } },
        visible: true,
        locked: false,
        components: [
            tComponent({ x: 1920/2, y: 1080/2, z: -2666, focalLength: 2666 })
        ]
    };
}

// Generate the composition
function generateComposition() {
    const rootId = 'comp_root';
    const nodes = {};

    // Root node
    nodes[rootId] = {
        id: rootId,
        name: 'Root',
        parent: null,
        children: [],
        transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
        visible: true,
        locked: false,
        components: []
    };

    const addNode = (node) => {
        nodes[node.id] = node;
        if (node.parent && nodes[node.parent]) {
            nodes[node.parent].children.push(node.id);
        } else if (node.parent === null && node.id !== rootId) {
            node.parent = rootId;
            nodes[rootId].children.push(node.id);
        }
    };

    // Camera
    const camera = createCamera();
    addNode(camera);

    // Dark SaaS Background
    const bg = createShape('Background', { x: 1920/2, y: 1080/2, width: 1920, height: 1080 }, { fill: '#0a0a0d' });
    bg.components.push(createComponent('fx', { solid: true }));
    addNode(bg);

    // 1. Scene 1: Strong Opening Statement (0s - 4s)
    const scene1Group = createGroup('Scene 1: Opening');
    addNode(scene1Group);
    
    const openingText1 = createText('Opening Text 1', 'The Future of Motion', { x: 1920/2, y: 1080/2 - 50, z: 200 }, { fontSize: 96, fontFamily: 'Inter', fontWeight: '800', fill: '#ffffff' }, scene1Group.id);
    const openingText2 = createText('Opening Text 2', 'Generated instantly by AI.', { x: 1920/2, y: 1080/2 + 50, z: 200 }, { fontSize: 48, fontFamily: 'Inter', fontWeight: '400', fill: '#a0a0a5' }, scene1Group.id);
    addNode(openingText1);
    addNode(openingText2);

    // Glowing orb behind text
    const glowOrb = createShape('Glow Orb', { x: 1920/2, y: 1080/2, width: 800, height: 800, shapeType: 'ellipse' }, { fill: 'rgba(102, 51, 255, 0.15)', opacity: 100 }, scene1Group.id);
    glowOrb.components.push(createComponent('fx', { effects: [{ type: 'blur', amount: 200, enabled: true }] }));
    addNode(glowOrb);

    // 2. Scene 2: Product UI Demo (4s - 12s)
    const scene2Group = createGroup('Scene 2: UI Demo');
    addNode(scene2Group);

    // Browser Window Precomp
    const browserPrecomp = createGroup('Browser Window', scene2Group.id, true);
    addNode(browserPrecomp);
    
    // Browser Base
    const browserBase = createShape('Browser Base', { x: 1920/2, y: 1080/2, width: 1400, height: 800 }, { fill: '#14141a' }, browserPrecomp.id);
    browserBase.components.push(createComponent('fx', { effects: [{ type: 'drop-shadow', amount: 80, enabled: true }] }));
    addNode(browserBase);

    // Browser Header
    const browserHeader = createShape('Browser Header', { x: 1920/2, y: 1080/2 - 400 + 30, width: 1400, height: 60 }, { fill: '#1c1c24' }, browserPrecomp.id);
    addNode(browserHeader);

    // Browser Dots
    for(let i=0; i<3; i++) {
        const colors = ['#ff5f56', '#ffbd2e', '#27c93f'];
        const dot = createShape(`Dot ${i}`, { x: 1920/2 - 700 + 40 + i*30, y: 1080/2 - 400 + 30, width: 16, height: 16, shapeType: 'ellipse' }, { fill: colors[i] }, browserPrecomp.id);
        addNode(dot);
    }

    // UI Cards inside browser
    for(let i=0; i<3; i++) {
        const card = createShape(`UI Card ${i}`, { x: 1920/2 - 350 + i*350, y: 1080/2 + 50, width: 300, height: 400, z: -50 }, { fill: '#1f1f29' }, browserPrecomp.id);
        addNode(card);
        const cardText = createText(`Card Text ${i}`, `Feature ${i+1}`, { x: 1920/2 - 350 + i*350, y: 1080/2 - 80, z: -50 }, { fontSize: 32, fontWeight: '600', fill: '#ffffff' }, browserPrecomp.id);
        addNode(cardText);
    }

    // 3. Scene 3: Feature Highlights (12s - 18s)
    const scene3Group = createGroup('Scene 3: Highlights');
    addNode(scene3Group);

    // Graph Component
    const graphLine = createShape('Graph Line', { x: 1920/2, y: 1080/2, width: 1000, height: 400, shapeType: 'line' }, { fill: 'rgba(0,0,0,0)', opacity: 100 }, scene3Group.id);
    graphLine.components.push(createComponent('Geometry', {
        points: [
            { x: -500, y: 150 }, { x: -200, y: -50 }, { x: 100, y: 50 }, { x: 500, y: -150 }
        ]
    }));
    // Style stroke
    const graphStyle = graphLine.components.find(c => c.type === 'Style');
    graphStyle.props.stroke = { color: '#6a4bff', width: 12, opacity: 1, cap: 'round', join: 'round' };
    addNode(graphLine);

    const graphText = createText('Graph Heading', 'Accelerated Growth', { x: 1920/2, y: 1080/2 - 250 }, { fontSize: 72, fontWeight: '700', fill: '#ffffff' }, scene3Group.id);
    addNode(graphText);

    // 4. Scene 4: Strong CTA (18s - 25s)
    const scene4Group = createGroup('Scene 4: CTA');
    addNode(scene4Group);

    const ctaText1 = createText('CTA Heading', 'Ready to ship faster?', { x: 1920/2, y: 1080/2 - 60 }, { fontSize: 96, fontWeight: '800', fill: '#ffffff' }, scene4Group.id);
    addNode(ctaText1);

    const ctaButton = createShape('CTA Button', { x: 1920/2, y: 1080/2 + 80, width: 300, height: 80 }, { fill: '#6a4bff' }, scene4Group.id);
    addNode(ctaButton);

    const ctaButtonText = createText('CTA Button Text', 'Get Started', { x: 1920/2, y: 1080/2 + 80 }, { fontSize: 32, fontWeight: '600', fill: '#ffffff' }, scene4Group.id);
    addNode(ctaButtonText);

    // ANIMATIONS
    const tracks = {};

    function addKeyframe(nodeId, property, time, value, easing = [0.25, 0.1, 0.25, 1.0]) {
        if (!tracks[nodeId]) tracks[nodeId] = {};
        if (!tracks[nodeId][property]) tracks[nodeId][property] = [];
        tracks[nodeId][property].push({ time, value, easing });
    }

    // Camera move (0-25s)
    addKeyframe(camera.id, 'z', 0, -1000);
    addKeyframe(camera.id, 'z', 4, -2666, [0.16, 1, 0.3, 1]); // Snap back for UI demo
    addKeyframe(camera.id, 'rotationX', 4, 0);
    addKeyframe(camera.id, 'rotationX', 12, 15, [0.4, 0, 0.2, 1]); // Tilt down on UI
    addKeyframe(camera.id, 'rotationY', 4, 0);
    addKeyframe(camera.id, 'rotationY', 12, -10, [0.4, 0, 0.2, 1]); // Pan slightly

    addKeyframe(camera.id, 'z', 12, -2666);
    addKeyframe(camera.id, 'z', 14, -1500, [0.16, 1, 0.3, 1]); // Zoom to graph
    addKeyframe(camera.id, 'rotationX', 14, 0);
    addKeyframe(camera.id, 'rotationY', 14, 0);

    addKeyframe(camera.id, 'z', 18, -1500);
    addKeyframe(camera.id, 'z', 20, -2666, [0.16, 1, 0.3, 1]); // Zoom out for CTA

    // Scene 1 Opacity
    addKeyframe(scene1Group.id, 'opacity', 0, 0);
    addKeyframe(scene1Group.id, 'opacity', 1, 100);
    addKeyframe(scene1Group.id, 'opacity', 3.5, 100);
    addKeyframe(scene1Group.id, 'opacity', 4, 0);

    // Scene 1 Text Fly in
    addKeyframe(openingText1.id, 'y', 0, 1080/2 + 50);
    addKeyframe(openingText1.id, 'y', 1, 1080/2 - 50, [0.16, 1, 0.3, 1]);
    addKeyframe(openingText2.id, 'y', 0.2, 1080/2 + 150);
    addKeyframe(openingText2.id, 'y', 1.2, 1080/2 + 50, [0.16, 1, 0.3, 1]);

    // Scene 2 Opacity (UI Demo)
    addKeyframe(scene2Group.id, 'opacity', 0, 0);
    addKeyframe(scene2Group.id, 'opacity', 3.8, 0);
    addKeyframe(scene2Group.id, 'opacity', 4.5, 100);
    addKeyframe(scene2Group.id, 'opacity', 11.5, 100);
    addKeyframe(scene2Group.id, 'opacity', 12, 0);

    // Browser Window 3D fly in
    addKeyframe(browserPrecomp.id, 'z', 3.8, -1000);
    addKeyframe(browserPrecomp.id, 'z', 5, 0, [0.16, 1, 0.3, 1]);
    addKeyframe(browserPrecomp.id, 'rotationX', 3.8, -20);
    addKeyframe(browserPrecomp.id, 'rotationX', 5, 0, [0.16, 1, 0.3, 1]);

    // Scene 3 Opacity (Graph)
    addKeyframe(scene3Group.id, 'opacity', 0, 0);
    addKeyframe(scene3Group.id, 'opacity', 11.8, 0);
    addKeyframe(scene3Group.id, 'opacity', 12.5, 100);
    addKeyframe(scene3Group.id, 'opacity', 17.5, 100);
    addKeyframe(scene3Group.id, 'opacity', 18, 0);

    // Scene 4 Opacity (CTA)
    addKeyframe(scene4Group.id, 'opacity', 0, 0);
    addKeyframe(scene4Group.id, 'opacity', 17.8, 0);
    addKeyframe(scene4Group.id, 'opacity', 18.5, 100);

    // CTA Button scale heartbeat
    addKeyframe(ctaButton.id, 'scale', 20, 1);
    addKeyframe(ctaButton.id, 'scale', 20.2, 1.1, [0.25, 0.1, 0.25, 1.0]);
    addKeyframe(ctaButton.id, 'scale', 20.6, 1, [0.25, 0.1, 0.25, 1.0]);
    addKeyframe(ctaButton.id, 'scale', 22, 1);
    addKeyframe(ctaButton.id, 'scale', 22.2, 1.1, [0.25, 0.1, 0.25, 1.0]);
    addKeyframe(ctaButton.id, 'scale', 22.6, 1, [0.25, 0.1, 0.25, 1.0]);

    addKeyframe(ctaButtonText.id, 'scale', 20, 1);
    addKeyframe(ctaButtonText.id, 'scale', 20.2, 1.1, [0.25, 0.1, 0.25, 1.0]);
    addKeyframe(ctaButtonText.id, 'scale', 20.6, 1, [0.25, 0.1, 0.25, 1.0]);
    addKeyframe(ctaButtonText.id, 'scale', 22, 1);
    addKeyframe(ctaButtonText.id, 'scale', 22.2, 1.1, [0.25, 0.1, 0.25, 1.0]);
    addKeyframe(ctaButtonText.id, 'scale', 22.6, 1, [0.25, 0.1, 0.25, 1.0]);

    // Format final JSON project
    const project = {
        id: 'project_saas_benchmark',
        name: 'SaaS Advertisement Benchmark',
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        revision: 1,
        width: 1920,
        height: 1080,
        fps: 60,
        duration: 25,
        nodes,
        tracks
    };

    return project;
}

const proj = generateComposition();
fs.writeFileSync(path.join(__dirname, 'saas_benchmark_project.json'), JSON.stringify(proj, null, 2));
console.log('Project generated: saas_benchmark_project.json');
