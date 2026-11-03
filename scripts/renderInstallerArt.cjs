/**
 * Renders the Windows installer bitmaps from scripts/installer-art/art.html.
 *
 *   npx electron scripts/renderInstallerArt.cjs
 *
 * Writes build/installerSidebar.bmp, build/uninstallerSidebar.bmp and
 * build/installerHeader.bmp (electron-builder's default names for nsis
 * installerSidebar / uninstallerSidebar / installerHeader). The BMPs are
 * tracked, so packaging never needs this script; run it after editing the HTML.
 *
 * NSIS only loads uncompressed BMP, so the captured PNG is written out here as
 * 24-bit bottom-up BMP by hand (no image library needed for that format).
 */
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(__dirname, 'installer-art', 'art.html');
const OUT = path.join(ROOT, 'build');

const ARTS = [
  { art: 'sidebar', file: 'installerSidebar.bmp', width: 328, height: 628 },
  { art: 'unsidebar', file: 'uninstallerSidebar.bmp', width: 328, height: 628 },
  { art: 'header', file: 'installerHeader.bmp', width: 300, height: 114 },
];

/** BGRA bitmap (Electron's toBitmap) → 24-bit BMP file bytes. */
function toBmp24(bgra, width, height) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const dataSize = rowSize * height;
  const buf = Buffer.alloc(54 + dataSize);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(54 + dataSize, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22); // positive = bottom-up
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(dataSize, 34);
  buf.writeInt32LE(3780, 38); // 96 dpi
  buf.writeInt32LE(3780, 42);
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4;
    const dst = 54 + y * rowSize;
    for (let x = 0; x < width; x++) {
      buf[dst + x * 3] = bgra[src + x * 4];
      buf[dst + x * 3 + 1] = bgra[src + x * 4 + 1];
      buf[dst + x * 3 + 2] = bgra[src + x * 4 + 2];
    }
  }
  return buf;
}

async function render({ art, file, width, height }) {
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    useContentSize: true,
    // Offscreen paints at device scale 1, so the capture is exactly
    // width x height whatever the display scaling of this machine.
    webPreferences: { offscreen: true },
  });
  await win.loadFile(PAGE, { query: { art } });
  await win.webContents.executeJavaScript(
    'new Promise((r) => { const t = () => document.body.dataset.ready ? r() : setTimeout(t, 20); t(); })',
  );
  // One more frame so the font swap has painted.
  await new Promise((r) => setTimeout(r, 150));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width, height });
  const size = image.getSize();
  if (size.width !== width || size.height !== height) {
    throw new Error(`${art}: captured ${size.width}x${size.height}, expected ${width}x${height}`);
  }
  fs.writeFileSync(path.join(OUT, file), toBmp24(image.toBitmap(), width, height));
  fs.writeFileSync(path.join(OUT, file.replace(/\.bmp$/, '.preview.png')), image.toPNG());
  win.destroy();
  console.log(`wrote build/${file} (${width}x${height})`);
}

app.disableHardwareAcceleration();
// Each art closes its window; without this the default quits the app after the first.
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  try {
    for (const a of ARTS) await render(a);
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
