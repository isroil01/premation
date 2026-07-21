const fs = require('fs');

let content = fs.readFileSync('packages/renderer/src/rendergraph/passes/CompositionPass.ts', 'utf8');

const importsToAdd1 = `import { BLUR_MATERIAL, GRADIENT_RAMP_MATERIAL, FRACTAL_NOISE_MATERIAL, DISPLACEMENT_MAP_MATERIAL, MOTION_TILE_MATERIAL } from '../../shaders/Material';`;
const importsToAdd2 = `import { packBlur, packGradientRamp, packFractalNoise, packDisplacementMap, packMotionTile } from '../../pipeline/uniforms';`;

content = content.replace(`import { BLUR_MATERIAL } from '../../shaders/Material';`, importsToAdd1);
content = content.replace(`import { packBlur } from '../../pipeline/uniforms';`, importsToAdd2);

const newEffectsCode = `
          } else if (effect.type === 'gradient-ramp') {
            const rampCmds = new CommandBuffer();
            rampCmds.add({
              batchKey: 'ramp', material: GRADIENT_RAMP_MATERIAL, blend: r.blend,
              uniforms: packGradientRamp(mvpFor(viewport, modelFromRect({ x: 0, y: 0, width: viewport.pixelSize.width, height: viewport.pixelSize.height })), { x: 0, y: 0, width: 1, height: 1 }, [effect.colorA || Color.white(), effect.colorB || Color.black()], [0, 0, 1, 1], effect.blend),
              texture: layerTex, sampler: services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' }),
            });
            const enc = beginViewportPass(ctx, 'ramp', writeAttachment(ctx, SURFACE));
            services.quad.execute(enc, rampCmds);
            enc.end();
          } else if (effect.type === 'fractal-noise') {
            const fnCmds = new CommandBuffer();
            fnCmds.add({
              batchKey: 'noise', material: FRACTAL_NOISE_MATERIAL, blend: r.blend,
              uniforms: packFractalNoise(mvpFor(viewport, modelFromRect({ x: 0, y: 0, width: viewport.pixelSize.width, height: viewport.pixelSize.height })), { x: 0, y: 0, width: 1, height: 1 }, effect.scale, 0, 0, 4),
              texture: layerTex, sampler: services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' }),
            });
            const enc = beginViewportPass(ctx, 'noise', writeAttachment(ctx, SURFACE));
            services.quad.execute(enc, fnCmds);
            enc.end();
          } else if (effect.type === 'displacement-map') {
            const dmCmds = new CommandBuffer();
            dmCmds.add({
              batchKey: 'displace', material: DISPLACEMENT_MAP_MATERIAL, blend: r.blend,
              uniforms: packDisplacementMap(mvpFor(viewport, modelFromRect({ x: 0, y: 0, width: viewport.pixelSize.width, height: viewport.pixelSize.height })), { x: 0, y: 0, width: 1, height: 1 }, effect.amount / viewport.pixelSize.width, effect.amount / viewport.pixelSize.height),
              texture: layerTex, sampler: services.resources.sampler('linear-clamp', { min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' }),
              texture2: layerTex, // Ideally this would be the displacement map source texture
            });
            const enc = beginViewportPass(ctx, 'displace', writeAttachment(ctx, SURFACE));
            services.quad.execute(enc, dmCmds);
            enc.end();
          } else if (effect.type === 'motion-tile') {
            const mtCmds = new CommandBuffer();
            mtCmds.add({
              batchKey: 'motiontile', material: MOTION_TILE_MATERIAL, blend: r.blend,
              uniforms: packMotionTile(mvpFor(viewport, modelFromRect({ x: 0, y: 0, width: viewport.pixelSize.width, height: viewport.pixelSize.height })), { x: 0, y: 0, width: 1, height: 1 }, effect.scale, effect.scale, 0, 0),
              texture: layerTex, sampler: services.resources.sampler('linear-repeat', { min: 'linear', mag: 'linear', addressU: 'repeat', addressV: 'repeat' }),
            });
            const enc = beginViewportPass(ctx, 'motiontile', writeAttachment(ctx, SURFACE));
            services.quad.execute(enc, mtCmds);
            enc.end();
          }
`;

content = content.replace(
  `          }
        }
      }
    }
    
    flushMain();`,
  `          }
        } ${newEffectsCode}
      }
    }
    
    flushMain();`
);

fs.writeFileSync('packages/renderer/src/rendergraph/passes/CompositionPass.ts', content);
console.log('Updated CompositionPass.ts');
