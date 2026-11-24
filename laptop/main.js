const { app, BrowserWindow, ipcMain, clipboard, dialog, Notification, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const dgram = require('dgram');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');
const secure = require('./secure');

// Test copy (`npm run start:test`): its own pairing/settings and port, used with the
// OnePlus 13R emulator so the user's real phone stays paired with the normal copy.
const TEST_MODE = process.argv.includes('--test');
if (TEST_MODE) app.setPath('userData', path.join(app.getPath('appData'), 'Simple Test'));

const PORT = TEST_MODE ? 8788 : 8787;
const DISCOVERY_PORT = PORT + 2; // UDP: the phone asks "where is my laptop?" here (8789 / test 8790)
const OTP_LIFETIME_MS = 2 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 3;
const MAX_CLIP = 200000; // max characters synced at once
const CLIP_CHECK_MS = 700;

let win = null;
let wss = null;
let state = { screen: 'loading' };

let pairToken = null; // one-time token inside the current QR code
let pending = null; // phone that scanned the QR and still has to enter the OTP
// Signed-in connections from the paired phone. There can be two at once:
// the app screen and the phone's background clipboard service.
const phones = new Set();
const HEARTBEAT_MS = 30000;

// clipboard sync
let clipSync = true; // on/off switch (saved in settings.json)
let lastClip = null; // last text synced either way (stops echo loops)

// Simple Drop (send photos/files between phone and laptop)
let dropOn = false; // on/off switch (saved in settings.json)
let dropFolder = null; // where received files are saved (saved in settings.json)

let startWithWindows = true; // tray menu option (saved in settings.json)
const DROP_CHUNK = 256 * 1024;
const DROP_MAX_BUFFER = 8 * 1024 * 1024;

// ---------- saved pairing ----------

function storePath() {
  return path.join(app.getPath('userData'), 'pairing.json');
}

function loadPairing() {
  try {
    return JSON.parse(fs.readFileSync(storePath(), 'utf8'));
  } catch {
    return null;
  }
}

function savePairing(data) {
  fs.writeFileSync(storePath(), JSON.stringify(data, null, 2));
}

function clearPairing() {
  try {
    fs.unlinkSync(storePath());
  } catch {}
  lastClip = null;
}

// ---------- settings ----------

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    if (typeof s.clipboardSync === 'boolean') clipSync = s.clipboardSync;
    if (typeof s.dropFolder === 'string' && fs.existsSync(s.dropFolder)) dropFolder = s.dropFolder;
    if (typeof s.dropOn === 'boolean') dropOn = s.dropOn && !!dropFolder;
    if (typeof s.startWithWindows === 'boolean') startWithWindows = s.startWithWindows;
  } catch {}
}

function saveSettings() {
  fs.writeFileSync(
    settingsPath(),
    JSON.stringify({ clipboardSync: clipSync, dropOn, dropFolder, startWithWindows }, null, 2)
  );
}

// ---------- clipboard sync ----------

// Note: in this Electron version clipboard.readText()/writeText() return Promises, so we await them.

// Watch the laptop clipboard and send new text to the phone.
function startClipboardWatch() {
  let busy = false;
  setInterval(async () => {
    if (busy || !clipSync || phones.size === 0) return;
    busy = true;
    try {
      const text = await clipboard.readText();
      if (typeof text !== 'string' || !text || text === lastClip || phones.size === 0) return;
      lastClip = text;
      // Only to the phone's background service (encrypted). The app screen connection never gets content.
      for (const ws of phones) if (ws.client === 'service') send(ws, { type: 'clipboard', text: text.slice(0, MAX_CLIP) });
    } catch {
      // clipboard busy (another app is using it): try again on the next tick
    } finally {
      busy = false;
    }
  }, CLIP_CHECK_MS);
}

// Text copied on the phone -> put it on the laptop clipboard.
async function receiveClipboard(text) {
  if (!clipSync || typeof text !== 'string' || !text) return;
  text = text.slice(0, MAX_CLIP);
  lastClip = text;
  try {
    await clipboard.writeText(text);
  } catch {}
}

// ---------- Simple Drop ----------

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', bmp: 'image/bmp', mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', pdf: 'application/pdf', txt: 'text/plain',
  zip: 'application/zip', apk: 'application/vnd.android.package-archive',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function mimeFor(name) {
  return MIME[path.extname(name).slice(1).toLowerCase()] || 'application/octet-stream';
}

// Make a name from the phone safe for Windows.
function safeFileName(name) {
  let n = String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
  if (!n || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = `file_${Date.now()}`;
  return n.slice(0, 180);
}

// "photo.jpg" -> "photo (1).jpg" if it already exists.
function uniquePath(folder, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = path.join(folder, name);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(folder, `${base} (${i})${ext}`);
  return candidate;
}

function toast(text) {
  if (win && !win.isDestroyed()) win.webContents.send('toast', text);
}

function notifyReceived(filePath) {
  const name = path.basename(filePath);
  toast(`Received ${name}`);
  if (Notification.isSupported()) {
    const n = new Notification({ title: 'Simple Drop', body: `Received ${name}` });
    n.on('click', () => shell.showItemInFolder(filePath));
    n.show();
  }
}

// Phone -> laptop: a file is arriving on this connection.
function dropStart(ws, msg) {
  if (!dropOn || !dropFolder || !fs.existsSync(dropFolder)) {
    return send(ws, { type: 'drop_reject', id: msg.id, reason: 'Simple Drop is off on the laptop.' });
  }
  dropAbort(ws);
  const name = safeFileName(msg.name);
  const partPath = path.join(dropFolder, `${name}.${String(msg.id).slice(0, 8)}.part`);
  ws.incoming = { id: msg.id, name, partPath, stream: fs.createWriteStream(partPath) };
  ws.incoming.stream.on('error', () => {
    send(ws, { type: 'drop_error', id: msg.id, message: 'Could not save the file on the laptop.' });
    dropAbort(ws);
  });
  send(ws, { type: 'drop_accept', id: msg.id });
}

function dropChunk(ws, data) {
  if (ws.incoming) ws.incoming.stream.write(data);
}

function dropEnd(ws, msg) {
  const inc = ws.incoming;
  if (!inc || inc.id !== msg.id) return;
  ws.incoming = null;
  inc.stream.end(() => {
    try {
      const finalPath = uniquePath(dropFolder, inc.name);
      fs.renameSync(inc.partPath, finalPath);
      send(ws, { type: 'drop_done', id: inc.id });
      notifyReceived(finalPath);
    } catch {
      send(ws, { type: 'drop_error', id: inc.id, message: 'Could not save the file on the laptop.' });
      fs.rm(inc.partPath, { force: true }, () => {});
    }
  });
}

// Connection dropped (or a new file started) before the file finished: throw away the half file.
function dropAbort(ws) {
  const inc = ws.incoming;
  if (!inc) return;
  ws.incoming = null;
  inc.stream.destroy();
  fs.rm(inc.partPath, { force: true }, () => {});
}

// Wait for the phone's answer about one file.
function waitForReply(ws, id, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.waiters.delete(id);
      resolve(null);
    }, ms);
    ws.waiters.set(id, (msg) => {
      clearTimeout(timer);
      ws.waiters.delete(id);
      resolve(msg);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Laptop -> phone: files dropped on the Simple window.
let sending = false;
async function sendFilesToPhone(paths) {
  if (sending) return toast('Still sending, please wait…');
  if (!dropOn) return toast('Turn on Simple Drop first.');
  const ws = [...phones].find((w) => w.client === 'service');
  if (!ws) return toast('Phone not ready. Open Simple on your phone and turn on Simple Drop.');

  const files = paths.filter((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
  if (files.length === 0) return toast('Drop files, not folders.');

  sending = true;
  let sent = 0;
  try {
    for (const [i, p] of files.entries()) {
      const name = path.basename(p);
      const id = crypto.randomUUID();
      toast(files.length > 1 ? `Sending ${name} (${i + 1} of ${files.length})…` : `Sending ${name}…`);
      send(ws, { type: 'drop_start', id, name, size: fs.statSync(p).size, mime: mimeFor(name) });
      const answer = await waitForReply(ws, id, 15000);
      if (!answer || answer.type !== 'drop_accept') {
        toast(answer?.reason || answer?.message || 'The phone did not answer.');
        break;
      }
      for await (const chunk of fs.createReadStream(p, { highWaterMark: DROP_CHUNK })) {
        if (ws.readyState !== ws.OPEN) throw new Error('closed');
        sendChunk(ws, chunk);
        while (ws.bufferedAmount > DROP_MAX_BUFFER && ws.readyState === ws.OPEN) await sleep(20);
      }
      send(ws, { type: 'drop_end', id });
      const done = await waitForReply(ws, id, 120000);
      if (done?.type !== 'drop_done') {
        toast(done?.message || `Could not send ${name}.`);
        break;
      }
      sent++;
    }
  } catch {
    toast('Connection to the phone was lost.');
  } finally {
    sending = false;
  }
  if (sent) toast(`Sent ${sent} file${sent > 1 ? 's' : ''} to your phone`);
}

// ---------- helpers ----------

function setState(next) {
  state = next;
  if (win && !win.isDestroyed()) win.webContents.send('state', state);
  if (TEST_MODE) writeTestPairing();
}

// Test copy only: write the pairing link and OTP to a file so the emulator can be paired
// automatically (the emulator has no camera to scan the screen).
let testLink = null;

// Test copy only: send files listed in test-send.json (same as dragging them onto the window).
function startTestSendWatch() {
  const file = path.join(app.getPath('userData'), 'test-send.json');
  setInterval(() => {
    if (!fs.existsSync(file)) return;
    let paths = [];
    try {
      paths = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
    fs.rmSync(file, { force: true });
    sendFilesToPhone(Array.isArray(paths) ? paths : []);
  }, 1000);
}
function writeTestPairing() {
  const info = { screen: state.screen, link: state.screen === 'qr' ? testLink : null, otp: state.otp || null };
  try {
    fs.writeFileSync(path.join(app.getPath('userData'), 'test-pairing.json'), JSON.stringify(info));
  } catch {}
}

// Encrypted once the phone's background service has signed in (ws.key), plain before that
// (pairing, sign-in) and for older phone app versions.
function send(ws, msg) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  if (ws.key) ws.send(secure.seal(ws.key, secure.KIND_JSON, Buffer.from(JSON.stringify(msg))), { binary: true });
  else ws.send(JSON.stringify(msg));
}

function sendChunk(ws, chunk) {
  if (ws.key) ws.send(secure.seal(ws.key, secure.KIND_CHUNK, chunk), { binary: true });
  else ws.send(chunk, { binary: true });
}

function sendToPhones(msg) {
  for (const ws of phones) send(ws, msg);
}

function closePhones() {
  for (const ws of phones) ws.close();
  phones.clear();
}

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Pick the laptop's Wi-Fi / LAN address (skip virtual adapters).
function getLocalIp() {
  const skip = /vethernet|virtual|vmware|vbox|hyper-v|loopback|bluetooth|wsl|docker/i;
  const prefer = /wi-?fi|wlan|wireless/i;
  const found = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && !skip.test(name)) found.push({ name, ip: a.address });
    }
  }
  const best = found.find((f) => prefer.test(f.name)) || found[0];
  return best ? best.ip : null;
}

// ---------- screens ----------

async function showQr() {
  pending = null;
  const ip = getLocalIp();
  if (!ip) {
    pairToken = null;
    setState({ screen: 'error', message: 'No Wi-Fi connection found. Connect the laptop to Wi-Fi and press Try again.' });
    return;
  }
  pairToken = crypto.randomBytes(16).toString('hex');
  const payload = JSON.stringify({ app: 'simple', v: 2, ip, port: PORT, dport: DISCOVERY_PORT, token: pairToken });
  if (TEST_MODE) testLink = `simpleapp://pair?data=${encodeURIComponent(payload)}`;
  const qr = await QRCode.toDataURL(payload, { width: 320, margin: 1 });
  setState({ screen: 'qr', qr, address: `${ip}:${PORT}` });
}

function showPaired() {
  const p = loadPairing();
  setState({
    screen: 'paired',
    deviceName: p ? p.deviceName : 'Phone',
    connected: phones.size > 0,
    phoneAddress: phones.size > 0 ? phones.values().next().value.remoteIp : null,
    pairedAt: p ? p.pairedAt : null,
    clipboardSync: clipSync,
    dropOn,
    dropFolder,
  });
}

function cancelPending(ws, message) {
  send(ws, { type: 'error', message });
  pending = null;
  setTimeout(() => ws.close(), 200);
  showQr();
}

// ---------- messages from the phone ----------

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'hello': {
      if (loadPairing()) {
        send(ws, { type: 'error', message: 'This laptop is already paired. Unpair it on the laptop first.' });
        return ws.close();
      }
      if (!pairToken || msg.token !== pairToken) {
        send(ws, { type: 'error', message: 'This QR code is old. Scan the new one on the laptop.' });
        return ws.close();
      }
      pairToken = null; // a QR code works only once
      const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      const expiresAt = Date.now() + OTP_LIFETIME_MS;
      // New phone app sends its public key: both sides compute the same secret (never sent).
      // Older app versions don't, and get a random secret in the "paired" message instead.
      let secret = null;
      let laptopPub;
      if (typeof msg.pub === 'string') {
        try {
          const key = secure.newPairingKey();
          secret = secure.pairingSecret(key.privateKey, msg.pub);
          laptopPub = key.pub;
        } catch {
          send(ws, { type: 'error', message: 'Pairing failed. Scan the QR code again.' });
          return ws.close();
        }
      }
      pending = {
        ws,
        otp,
        expiresAt,
        attempts: 0,
        deviceId: String(msg.deviceId || ''),
        deviceName: String(msg.deviceName || 'Phone').slice(0, 60),
        secret,
        legacy: !secret,
      };
      const thisPending = pending;
      setTimeout(() => {
        if (pending === thisPending) cancelPending(ws, 'The code expired. Scan the QR code again.');
      }, OTP_LIFETIME_MS);
      setState({ ...state, screen: 'otp', otp, deviceName: pending.deviceName, expiresAt });
      send(ws, { type: 'otp_required', pub: laptopPub });
      return;
    }

    case 'otp': {
      if (!pending || pending.ws !== ws) return send(ws, { type: 'error', message: 'Scan the QR code first.' });
      if (Date.now() > pending.expiresAt) return cancelPending(ws, 'The code expired. Scan the QR code again.');
      if (String(msg.code) === pending.otp) {
        const legacy = pending.legacy;
        const pairing = {
          laptopId: crypto.randomUUID(),
          deviceId: pending.deviceId,
          deviceName: pending.deviceName,
          secret: pending.secret || crypto.randomBytes(32).toString('hex'),
          securePairing: !legacy, // true = secret made by key swap, never sent over Wi-Fi
          pairedAt: new Date().toISOString(),
        };
        savePairing(pairing);
        pending = null;
        ws.client = 'app';
        phones.add(ws);
        send(ws, {
          type: 'paired',
          laptopId: pairing.laptopId,
          laptopName: os.hostname(),
          ...(legacy ? { secret: pairing.secret } : {}), // new app already has it from the key swap
        });
        showPaired();
        return;
      }
      pending.attempts += 1;
      const left = MAX_OTP_ATTEMPTS - pending.attempts;
      if (left <= 0) return cancelPending(ws, 'Too many wrong codes. Scan the QR code again.');
      return send(ws, { type: 'otp_wrong', left });
    }

    case 'reconnect': {
      const p = loadPairing();
      const client = msg.client === 'service' ? 'service' : 'app'; // phone background service or app screen
      let ok = false;
      let key = null;
      if (p && msg.deviceId === p.deviceId) {
        if (typeof msg.proof === 'string' && typeof msg.nonce === 'string') {
          // New app: proves it knows the secret without sending it.
          const n2 = Buffer.from(msg.nonce, 'base64');
          ok = n2.length >= 16 && sameSecret(msg.proof, secure.authProof(p.secret, ws.n1, n2, client));
          if (ok && client === 'service') key = secure.sessionKey(p.secret, ws.n1, n2);
        } else if (typeof msg.secret === 'string') {
          // Older app version (sends the secret, no encryption). Kept until the phone is updated.
          ok = sameSecret(msg.secret, p.secret);
        }
      }
      if (ok) {
        ws.client = client;
        phones.add(ws);
        if (key) ws.key = key; // from now on everything on this connection is encrypted
        send(ws, { type: 'reconnected', laptopName: os.hostname() });
        showPaired();
      } else {
        send(ws, { type: 'unpaired' });
        ws.close();
      }
      return;
    }

    case 'clipboard': {
      if (phones.has(ws)) receiveClipboard(msg.text); // only from the paired, signed-in phone
      return;
    }

    // Simple Drop: phone -> laptop
    case 'drop_start':
      if (phones.has(ws)) dropStart(ws, msg);
      return;
    case 'drop_end':
      if (phones.has(ws)) dropEnd(ws, msg);
      return;

    // Simple Drop: the phone answering about a file the laptop is sending
    case 'drop_accept':
    case 'drop_reject':
    case 'drop_done':
    case 'drop_error':
      ws.waiters.get(msg.id)?.(msg);
      return;

    case 'unpair': {
      const p = loadPairing();
      // Allowed from a signed-in connection (or, for older app versions, with the secret).
      if (p && (phones.has(ws) || (msg.deviceId === p.deviceId && sameSecret(msg.secret, p.secret)))) {
        clearPairing();
        sendToPhones({ type: 'unpaired' }); // tell the phone's other connection too
        closePhones();
        ws.close();
        showQr();
      }
      return;
    }
  }
}

// Auto-find: when the laptop's Wi-Fi address changes, the paired phone broadcasts
// "where is laptop <id>?" and we answer with our port and a proof that we know the secret.
function startDiscovery() {
  const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udp.on('error', () => {}); // auto-find is a bonus; the app works without it
  udp.on('message', (data, rinfo) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const p = loadPairing();
    if (msg.type !== 'simple-discover' || !p || msg.laptopId !== p.laptopId || typeof msg.nonce !== 'string') return;
    const reply = Buffer.from(
      JSON.stringify({
        type: 'simple-here',
        laptopId: p.laptopId,
        port: PORT,
        nonce: msg.nonce,
        proof: secure.hereProof(p.secret, msg.nonce),
      })
    );
    udp.send(reply, rinfo.port, rinfo.address);
  });
  udp.bind(DISCOVERY_PORT, '0.0.0.0');
}

function startServer() {
  wss = new WebSocketServer({ port: PORT, host: '0.0.0.0' });

  wss.on('error', (err) => {
    const message =
      err.code === 'EADDRINUSE'
        ? `Port ${PORT} is already in use. Close other copies of Simple and restart.`
        : `Could not start: ${err.message}`;
    setState({ screen: 'error', message });
  });

  // Drop connections that stopped answering (phone left Wi-Fi, app killed, ...)
  setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);

  wss.on('connection', (ws, req) => {
    ws.remoteIp = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    ws.isAlive = true;
    ws.waiters = new Map();
    ws.incoming = null;
    ws.key = null; // encryption key once the phone's background service signs in
    ws.n1 = crypto.randomBytes(16); // sign-in challenge for this connection
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', (raw, isBinary) => {
      if (ws.key) {
        // Encrypted connection: every frame must decrypt, or we drop the connection.
        if (!isBinary) return;
        let frame;
        try {
          frame = secure.open(ws.key, raw);
        } catch {
          return ws.terminate();
        }
        if (frame.kind === secure.KIND_CHUNK) return dropChunk(ws, frame.payload);
        let msg;
        try {
          msg = JSON.parse(frame.payload.toString());
        } catch {
          return;
        }
        return handleMessage(ws, msg);
      }
      if (isBinary) {
        if (phones.has(ws)) dropChunk(ws, raw); // file data from an older phone app version
        return;
      }
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      handleMessage(ws, msg);
    });
    send(ws, { type: 'challenge', nonce: ws.n1.toString('base64') });

    ws.on('close', () => {
      dropAbort(ws);
      for (const resolve of ws.waiters.values()) resolve(null);
      if (pending && pending.ws === ws) showQr(); // phone left before entering the OTP
      if (phones.delete(ws) && loadPairing()) showPaired();
    });
  });
}

// ---------- window & tray ----------

const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');
const START_HIDDEN = process.argv.includes('--hidden'); // started with Windows
let tray = null;
let quitting = false;
let trayHintShown = false;

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Start with Windows (normal copy only). Runs hidden in the tray at startup.
function applyStartWithWindows() {
  if (TEST_MODE) return;
  app.setLoginItemSettings(
    app.isPackaged
      ? { openAtLogin: startWithWindows, args: ['--hidden'] }
      : { openAtLogin: startWithWindows, path: process.execPath, args: [app.getAppPath(), '--hidden'] }
  );
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON_PATH).resize({ width: 32, height: 32 }));
  tray.setToolTip(TEST_MODE ? 'Simple (test)' : 'Simple');
  const menu = [{ label: TEST_MODE ? 'Open Simple (test)' : 'Open Simple', click: showWindow }];
  if (!TEST_MODE) {
    menu.push({
      label: 'Start with Windows',
      type: 'checkbox',
      checked: startWithWindows,
      click: (item) => {
        startWithWindows = item.checked;
        saveSettings();
        applyStartWithWindows();
      },
    });
  }
  menu.push({ type: 'separator' }, {
    label: 'Quit Simple',
    click: () => {
      quitting = true;
      app.quit();
    },
  });
  tray.setContextMenu(Menu.buildFromTemplate(menu));
  tray.on('click', showWindow);
}

function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 520,
    minHeight: 520,
    show: !START_HIDDEN,
    icon: ICON_PATH,
    title: TEST_MODE ? 'Simple (test)' : 'Simple',
    backgroundColor: '#f6f7fb',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: TEST_MODE ? ['--simple-test'] : [],
    },
  });
  // Keep "(test)" in the title bar so the two copies are easy to tell apart.
  win.on('page-title-updated', (e) => {
    if (TEST_MODE) e.preventDefault();
  });
  // Closing the window keeps Simple running in the tray, so the phone stays connected.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!trayHintShown && Notification.isSupported()) {
      trayHintShown = true;
      new Notification({
        title: 'Simple is still running',
        body: 'Your phone stays connected. Find Simple in the system tray to open or quit it.',
      }).show();
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('get-state', () => state);
ipcMain.handle('new-qr', () => showQr());
ipcMain.handle('set-clipboard-sync', (_event, on) => {
  clipSync = !!on;
  saveSettings();
  if (state.screen === 'paired') showPaired();
});
ipcMain.handle('pick-drop-folder', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Select your drop location',
    buttonLabel: 'Done',
    defaultPath: dropFolder || app.getPath('downloads'),
    properties: ['openDirectory', 'createDirectory'],
  });
  const changed = !result.canceled && !!result.filePaths[0];
  if (changed) {
    dropFolder = result.filePaths[0];
    saveSettings();
  }
  if (state.screen === 'paired') showPaired();
  return { changed };
});
ipcMain.handle('set-drop', (_event, on) => {
  if (on && !dropFolder) {
    showPaired();
    return { error: 'Select your drop location first.' };
  }
  dropOn = !!on;
  saveSettings();
  if (state.screen === 'paired') showPaired();
  return {};
});
ipcMain.handle('send-files', (_event, paths) => sendFilesToPhone(Array.isArray(paths) ? paths : []));
ipcMain.handle('unpair', () => {
  sendToPhones({ type: 'unpaired' });
  closePhones();
  clearPairing();
  showQr();
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Opening Simple again (e.g. from the Start menu) just shows the running copy.
  app.on('second-instance', showWindow);

  app.setAppUserModelId(TEST_MODE ? 'com.simpleapp.laptop.test' : 'com.simpleapp.laptop'); // for Windows notifications

  app.whenReady().then(() => {
    loadSettings();
    applyStartWithWindows();
    startServer();
    startDiscovery();
    startClipboardWatch();
    if (TEST_MODE) startTestSendWatch();
    createWindow();
    createTray();
    if (loadPairing()) showPaired();
    else showQr();
  });

  // Small log of why the app stopped (in the app's data folder: app.log), to track down unexpected quits.
  const logLine = (text) => {
    try {
      fs.appendFileSync(path.join(app.getPath('userData'), 'app.log'), `${new Date().toISOString()} ${text}\n`);
    } catch {}
  };
  logLine('started');
  process.on('uncaughtException', (err) => logLine(`error: ${err && err.stack ? err.stack : err}`));
  app.on('render-process-gone', (_e, _wc, details) => logLine(`window process gone: ${details.reason}`));
  app.on('child-process-gone', (_e, details) => logLine(`helper process gone: ${details.type} ${details.reason}`));
  app.on('session-end', () => logLine('Windows is signing out / shutting down'));
  app.on('before-quit', () => {
    logLine(quitting ? 'quit from the tray menu' : 'quit (not from the tray menu)');
    quitting = true;
  });
  // The window only hides, so this fires only when quitting.
  app.on('window-all-closed', () => app.quit());
}
