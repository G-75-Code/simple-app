const $ = (id) => document.getElementById(id);
const screens = ['loading', 'qr', 'paired', 'error'];
let timer = null;

function showScreen(name) {
  for (const s of screens) $(s).classList.toggle('hidden', s !== name);
}

function openPopup(id) {
  closePopups();
  $(id).classList.remove('hidden');
}

function closePopups() {
  for (const el of document.querySelectorAll('.popup-overlay')) el.classList.add('hidden');
}

function startCountdown(expiresAt) {
  clearInterval(timer);
  const tick = () => {
    const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    $('otp-timer').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    if (left === 0) clearInterval(timer);
  };
  tick();
  timer = setInterval(tick, 1000);
}

let current = { screen: 'loading' };

function renderClipboard(state) {
  $('clip-toggle').checked = !!state.clipboardSync;
}

function renderDrop(state) {
  $('drop-toggle').checked = !!state.dropOn;
  // No location yet: show "Select your drop location". Location set: only the change link
  // (the location itself is shown in the popup).
  $('drop-location').classList.toggle('hidden', !!state.dropFolder);
  $('drop-change').classList.toggle('hidden', !state.dropFolder);
  $('drop-current').textContent = state.dropFolder || '';
}

// ---------- toast ----------

let toastTimer = null;
function showToast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

function render(state) {
  current = state;
  const otpOpen = state.screen === 'otp';
  const paired = state.screen === 'paired';

  $('otp-modal').classList.toggle('hidden', !otpOpen);
  if (!otpOpen) clearInterval(timer);

  $('dot-btn').classList.toggle('hidden', !paired);
  $('logo-btn').disabled = !paired;
  if (!paired) closePopups();

  switch (state.screen) {
    case 'qr':
    case 'otp':
      if (state.qr) $('qr-img').src = state.qr;
      $('address').textContent = state.address || '';
      showScreen('qr');
      if (otpOpen) {
        $('otp-device').textContent = state.deviceName;
        $('otp-code').textContent = `${state.otp.slice(0, 3)} ${state.otp.slice(3)}`;
        startCountdown(state.expiresAt);
      }
      break;
    case 'paired':
      $('status-dot').classList.toggle('on', state.connected);
      $('info-name').textContent = state.deviceName;
      $('info-dot').classList.toggle('on', state.connected);
      $('info-status').textContent = state.connected ? 'Connected' : 'Not connected';
      $('info-address').textContent = state.phoneAddress || '—';
      $('info-paired-row').classList.toggle('hidden', !state.pairedAt);
      if (state.pairedAt) $('info-paired').textContent = new Date(state.pairedAt).toLocaleString();
      renderClipboard(state);
      renderDrop(state);
      showScreen('paired');
      break;
    case 'error':
      $('error-text').textContent = state.message;
      showScreen('error');
      break;
    default:
      showScreen('loading');
  }
}

$('new-qr').addEventListener('click', () => window.simple.newQr());
$('retry').addEventListener('click', () => window.simple.newQr());

$('clip-toggle').addEventListener('change', (e) => window.simple.setClipboardSync(e.target.checked));

// Simple Drop
// No location yet: pick one right away. Location set: change it from the popup.
$('drop-location').addEventListener('click', () => window.simple.pickDropFolder());
$('drop-change').addEventListener('click', () => openPopup('drop-popup'));
$('drop-change-btn').addEventListener('click', async () => {
  const result = await window.simple.pickDropFolder();
  if (result && result.changed) {
    closePopups();
    showToast('Drop location changed');
  }
});
$('drop-toggle').addEventListener('change', async (e) => {
  const result = await window.simple.setDrop(e.target.checked);
  if (result && result.error) {
    e.target.checked = false;
    showToast(result.error);
  }
});
window.simple.onToast(showToast);

// Drag files onto the window to send them to the phone
let dragDepth = 0;
const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
document.addEventListener('dragenter', (e) => {
  if (!hasFiles(e) || current.screen !== 'paired') return;
  e.preventDefault();
  dragDepth++;
  $('drag-overlay').classList.remove('hidden');
});
document.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $('drag-overlay').classList.add('hidden');
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drag-overlay').classList.add('hidden');
  if (current.screen !== 'paired' || !e.dataTransfer?.files?.length) return;
  window.simple.sendFiles([...e.dataTransfer.files]);
});

$('logo-btn').addEventListener('click', () => openPopup('menu-popup'));
$('dot-btn').addEventListener('click', () => openPopup('device-popup'));

// Close: the ✕ button or a click outside the popup
for (const el of document.querySelectorAll('.popup-overlay')) {
  el.addEventListener('click', (e) => {
    if (e.target === el || e.target.closest('[data-close]')) closePopups();
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePopups();
});

$('unpair').addEventListener('click', () => {
  if (confirm('Unpair this phone?')) {
    closePopups();
    window.simple.unpair();
  }
});

// Test copy: show a "Test" label next to the name
if (window.simple.isTest) {
  const badge = document.createElement('span');
  badge.className = 'test-badge';
  badge.textContent = 'Test';
  document.querySelector('.brand-row').appendChild(badge);
}

window.simple.onState(render);
window.simple.getState().then(render);
