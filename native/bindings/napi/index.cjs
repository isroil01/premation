/**
 * Loads the cmake-js output. `cmake-js compile` writes build/Release/motion_napi.node;
 * a Debug build lands in build/Debug. Nothing else is searched: a missing
 * binary is a build problem, not a runtime fallback (the TypeScript fallback
 * lives in packages/native-bridge, which is where the decision belongs).
 */
'use strict';

const path = require('node:path');

function load() {
  const candidates = [
    path.join(__dirname, 'build', 'Release', 'motion_napi.node'),
    path.join(__dirname, 'build', 'Debug', 'motion_napi.node'),
  ];
  let lastError;
  for (const file of candidates) {
    try {
      return require(file);
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`motion_napi.node not built (run \`npx cmake-js compile\` in ${__dirname}): ${lastError && lastError.message}`);
}

module.exports = load();
