// Draws the Simple logo (purple #4f5bd5 with a white "S") in every size the apps need.
// Run once with the laptop's Electron:
//   laptop\node_modules\.bin\electron.cmd tools\make-icon.js
//
// Laptop:  laptop/assets/icon.png (256, window + tray), laptop/build/icon.png (512, installer + .exe)
// Android: mobile/assets/icon.png (full square), android-icon-foreground.png (white S, transparent),
//          android-icon-background.png (purple), android-icon-monochrome.png (white S for themed icons)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const PURPLE = '#4f5bd5';
const root = path.join(__dirname, '..');

// kind: 'rounded' (laptop), 'square' (full-bleed), 'background', 'foreground' (S only)
const outputs = [
  { file: 'laptop/assets/icon.png', size: 256, kind: 'rounded' },
  { file: 'laptop/build/icon.png', size: 512, kind: 'rounded' },
  { file: 'mobile/assets/icon.png', size: 1024, kind: 'square' },
  { file: 'mobile/assets/android-icon-background.png', size: 1024, kind: 'background' },
  { file: 'mobile/assets/android-icon-foreground.png', size: 1024, kind: 'foreground' },
  { file: 'mobile/assets/android-icon-monochrome.png', size: 1024, kind: 'foreground' },
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 200, height: 200 });
  await win.loadURL('data:text/html,<body></body>');
  for (const o of outputs) {
    const dataUrl = await win.webContents.executeJavaScript(`(() => {
      const s = ${o.size}, kind = '${o.kind}';
      const c = document.createElement('canvas');
      c.width = c.height = s;
      const x = c.getContext('2d');
      x.fillStyle = '${PURPLE}';
      if (kind === 'rounded') { x.beginPath(); x.roundRect(s * 0.03, s * 0.03, s * 0.94, s * 0.94, s * 0.235); x.fill(); }
      if (kind === 'square' || kind === 'background') x.fillRect(0, 0, s, s);
      if (kind !== 'background') {
        // Android adaptive icons get cropped to a circle, so keep the S inside the safe middle area.
        const fontSize = kind === 'foreground' ? s * 0.42 : s * 0.67;
        x.fillStyle = '#ffffff';
        x.font = 'bold ' + fontSize + 'px "Segoe UI", Arial, sans-serif';
        x.textAlign = 'center';
        x.textBaseline = 'middle';
        x.fillText('S', s / 2, s * 0.54);
      }
      return c.toDataURL('image/png');
    })()`);
    const out = path.join(root, o.file);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('saved', o.file);
  }
  app.quit();
});
