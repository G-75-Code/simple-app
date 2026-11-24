import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
  Linking,
  KeyboardAvoidingView,
  Modal,
  PermissionsAndroid,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import SimpleClipboard from './modules/simple-clipboard';

const PAIRING_KEY = 'simple.pairing';
const DEVICE_ID_KEY = 'simple.deviceId';
const CLIP_SYNC_KEY = 'simple.clipboardSync';
const BATTERY_ASKED_KEY = 'simple.batteryAsked';
const DROP_KEY = 'simple.drop'; // { on, folder: { uri, name } }
const MAX_CLIP = 200000; // max characters synced at once

// In the installed Simple app a native background service does clipboard sync.
// In Expo Go it isn't available, so the app syncs itself while it is open.
const NATIVE_SYNC = Platform.OS === 'android' && !!SimpleClipboard;

// Testing on the Android emulator (it has no camera to scan the laptop screen).
// Only there, a simpleapp://pair link can start pairing; real phones always scan the QR code.
const IS_EMULATOR =
  Platform.OS === 'android' &&
  /sdk_gphone|emulator|generic/i.test(`${Platform.constants?.Fingerprint} ${Platform.constants?.Model}`);

// Laptop's UDP auto-find port (from the QR code; older pairings: laptop port + 2).
const discoveryPortOf = (p) => Number(p.dport || Number(p.port) + 2);

// One-time asks so background sync keeps running: notification + no battery sleep.
async function askBackgroundPermissions() {
  try {
    if (Platform.Version >= 33) {
      await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    }
    const asked = await AsyncStorage.getItem(BATTERY_ASKED_KEY);
    if (!asked && !SimpleClipboard.permissions().batteryUnrestricted) {
      await AsyncStorage.setItem(BATTERY_ASKED_KEY, '1');
      SimpleClipboard.requestBatteryUnrestricted();
    }
  } catch {}
}

// ---------- helpers ----------

async function getDeviceId() {
  let id = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

function getDeviceName() {
  const c = Platform.constants || {};
  const brand = c.Brand ? c.Brand.charAt(0).toUpperCase() + c.Brand.slice(1) : '';
  return [brand, c.Model].filter(Boolean).join(' ') || 'Phone';
}

function Button({ title, onPress, kind = 'primary', disabled }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        kind === 'primary' ? styles.primary : styles.secondary,
        kind === 'danger' && styles.danger,
        (pressed || disabled) && { opacity: 0.6 },
      ]}
    >
      <Text style={[styles.buttonText, kind !== 'primary' && styles.buttonTextDark, kind === 'danger' && styles.dangerText]}>
        {title}
      </Text>
    </Pressable>
  );
}

function Popup({ visible, title, onClose, children }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.popup} onPress={() => {}}>
          <View style={styles.popupHeader}>
            <Text style={styles.popupTitle}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={12} style={styles.closeBtn}>
              <Text style={styles.closeText}>✕</Text>
            </Pressable>
          </View>
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function InfoRow({ label, value }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      {typeof value === 'string' ? <Text style={styles.infoValue}>{value}</Text> : value}
    </View>
  );
}

// ---------- QR scanner ----------

function Scanner({ onScanned, onCancel }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [hint, setHint] = useState('');
  const done = useRef(false);

  if (!permission) return <View style={styles.center} />;

  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Camera needed</Text>
        <Text style={styles.muted}>Simple needs the camera to scan the QR code on your laptop.</Text>
        <Button title="Allow camera" onPress={requestPermission} />
        <Button title="Cancel" kind="secondary" onPress={onCancel} />
      </View>
    );
  }

  const handleScan = ({ data }) => {
    if (done.current) return;
    let info = null;
    try {
      info = JSON.parse(data);
    } catch {}
    if (info && info.app === 'simple' && info.ip && info.port && info.token) {
      done.current = true;
      onScanned(info);
    } else {
      setHint("That's not a Simple QR code.");
    }
  };

  return (
    <View style={styles.scanner}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={handleScan}
      />
      <View style={styles.scanOverlay}>
        <Text style={styles.scanText}>Point at the QR code on your laptop</Text>
        <View style={styles.frame} />
        {hint ? <Text style={styles.scanHint}>{hint}</Text> : null}
        <Pressable onPress={onCancel} style={styles.scanCancel}>
          <Text style={styles.scanCancelText}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ---------- app ----------

export default function App() {
  const [screen, setScreen] = useState('loading'); // loading | home | scan | connecting | otp | paired
  const [pairing, setPairing] = useState(null);
  const [message, setMessage] = useState('');
  const [otp, setOtp] = useState('');
  const [connected, setConnected] = useState(false);
  const [popup, setPopup] = useState(null); // null | 'menu' | 'device'
  const wsRef = useRef(null);
  const connectedRef = useRef(false);

  // clipboard sync
  const [clipSync, setClipSync] = useState(true);
  // Simple Drop
  const [dropOn, setDropOn] = useState(false);
  const [dropFolder, setDropFolder] = useState(null); // { uri, name }
  const clipSyncRef = useRef(true);
  const lastClipRef = useRef(null); // last text synced either way (stops echo loops)

  const setLive = (value) => {
    connectedRef.current = value;
    setConnected(value);
  };

  // Phone clipboard -> laptop
  const sendClipboard = async () => {
    if (NATIVE_SYNC) return; // the background service handles it
    const ws = wsRef.current;
    if (!clipSyncRef.current || !connectedRef.current || !ws || ws.readyState !== WebSocket.OPEN) return;
    let text = '';
    try {
      text = await Clipboard.getStringAsync();
    } catch {
      return;
    }
    if (!text) return; // empty, or Android not letting us read yet
    text = text.slice(0, MAX_CLIP);
    if (text === lastClipRef.current) return; // already synced
    lastClipRef.current = text;
    ws.send(JSON.stringify({ type: 'clipboard', text }));
  };

  // Android only lets an app read the clipboard once its window has focus,
  // which happens a moment after the app opens, so read a bit later and retry once.
  const sendClipboardSoon = () => {
    setTimeout(() => sendClipboard(), 600);
    setTimeout(() => sendClipboard(), 1800);
  };

  // Laptop clipboard -> phone
  const receiveClipboard = (text) => {
    if (NATIVE_SYNC) return; // the background service handles it
    if (!clipSyncRef.current || typeof text !== 'string' || !text) return;
    lastClipRef.current = text;
    Clipboard.setStringAsync(text);
  };

  // Installed app: ask once per app session to turn on the Accessibility helper
  // (needed so copies in other apps reach the laptop while Simple is closed).
  const copyWatchAskedRef = useRef(false);
  const askCopyWatch = () => {
    if (!NATIVE_SYNC || copyWatchAskedRef.current) return;
    try {
      if (SimpleClipboard.isCopyWatchOn()) return;
    } catch {
      return;
    }
    copyWatchAskedRef.current = true;
    Alert.alert(
      'Turn on background sync',
      'To send what you copy on this phone to your laptop without opening Simple, turn on "Simple clipboard sync" in Accessibility settings.',
      [
        { text: 'Not now', style: 'cancel' },
        { text: 'Open settings', onPress: () => SimpleClipboard.openCopyWatchSettings() },
      ]
    );
  };

  const toggleClipSync = (on) => {
    if (on) copyWatchAskedRef.current = false;
    clipSyncRef.current = on;
    setClipSync(on);
    AsyncStorage.setItem(CLIP_SYNC_KEY, on ? 'on' : 'off');
    if (on) sendClipboard();
  };

  // Load clipboard sync + Simple Drop settings
  useEffect(() => {
    AsyncStorage.getItem(CLIP_SYNC_KEY).then((v) => {
      if (v === 'off') {
        clipSyncRef.current = false;
        setClipSync(false);
      }
    });
    AsyncStorage.getItem(DROP_KEY).then((raw) => {
      if (!raw) return;
      try {
        const d = JSON.parse(raw);
        setDropFolder(d.folder || null);
        setDropOn(!!d.on && !!d.folder);
      } catch {}
    });
  }, []);

  // ---------- Simple Drop ----------

  const saveDrop = (on, folder) => AsyncStorage.setItem(DROP_KEY, JSON.stringify({ on, folder }));

  const toggleDrop = (on) => {
    if (on && !dropFolder) {
      Alert.alert('Simple Drop', 'Select your drop location first.');
      return;
    }
    setDropOn(on);
    saveDrop(on, dropFolder);
  };

  const pickDropLocation = async () => {
    try {
      const picked = await SimpleClipboard.pickDropFolder();
      if (!picked) return false; // cancelled
      setDropFolder(picked);
      saveDrop(dropOn, picked);
      return true;
    } catch {
      Alert.alert('Simple Drop', "Couldn't open the folder picker.");
      return false;
    }
  };

  // Installed app: run the native background service while paired and any feature is on
  useEffect(() => {
    if (!NATIVE_SYNC || screen !== 'paired' || !pairing) return;
    const dropActive = dropOn && !!dropFolder;
    if (!clipSync && !dropActive) {
      SimpleClipboard.stop();
      return;
    }
    const start = () =>
      SimpleClipboard.start({
        ip: pairing.ip,
        port: Number(pairing.port),
        deviceId: pairing.deviceId,
        secret: pairing.secret,
        laptopId: pairing.laptopId || '',
        discoveryPort: discoveryPortOf(pairing),
        clipboardOn: clipSync,
        dropOn: dropActive,
        dropUri: dropActive ? dropFolder.uri : '',
      });
    let cancelled = false;
    askBackgroundPermissions().then(() => {
      if (cancelled) return;
      start();
      if (clipSync) askCopyWatch();
    });
    // Opening the app again refreshes the service (restarts it if Android stopped it)
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') start();
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [screen, pairing, clipSync, dropOn, dropFolder]);

  // Expo Go: send the phone clipboard when it changes or when the app is opened again
  useEffect(() => {
    if (NATIVE_SYNC || screen !== 'paired') return;
    const appSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') sendClipboardSoon();
    });
    const clipSub = Clipboard.addClipboardListener(() => sendClipboard());
    return () => {
      appSub.remove();
      clipSub.remove();
    };
  }, [screen]);

  // Load saved pairing on start
  useEffect(() => {
    AsyncStorage.getItem(PAIRING_KEY).then((raw) => {
      if (raw) {
        setPairing(JSON.parse(raw));
        setScreen('paired');
      } else {
        setScreen('home');
      }
    });
  }, []);

  const closeSocket = () => {
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
  };

  const goHome = (text = '') => {
    closeSocket();
    setOtp('');
    setMessage(text);
    setScreen('home');
  };

  // Android back button returns to home during pairing
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (['scan', 'connecting', 'otp'].includes(screen)) {
        goHome();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [screen]);

  // Step 1: QR scanned -> connect to laptop
  const startPairing = async (info) => {
    setScreen('connecting');
    setMessage('');
    const deviceId = await getDeviceId();
    // Secure pairing: swap public keys with the laptop; both sides compute the same secret,
    // so it is never sent over Wi-Fi.
    let pub;
    let secret = null;
    if (NATIVE_SYNC) {
      try {
        pub = SimpleClipboard.createPairingKey();
      } catch {}
    }
    const ws = new WebSocket(`ws://${info.ip}:${info.port}`);
    wsRef.current = ws;

    const timeout = setTimeout(() => {
      if (wsRef.current === ws && ws.readyState !== WebSocket.OPEN) {
        goHome("Couldn't reach the laptop. Make sure both are on the same Wi-Fi.");
      }
    }, 8000);

    ws.onopen = () => {
      clearTimeout(timeout);
      ws.send(JSON.stringify({ type: 'hello', token: info.token, deviceId, deviceName: getDeviceName(), pub }));
    };

    ws.onmessage = async (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === 'otp_required') {
        if (msg.pub && pub) {
          try {
            secret = SimpleClipboard.finishPairing(msg.pub);
          } catch {
            goHome('Pairing failed. Scan the QR code again.');
            return;
          }
        }
        setOtp('');
        setMessage('');
        setScreen('otp');
      } else if (msg.type === 'otp_wrong') {
        setOtp('');
        setMessage(`Wrong code. ${msg.left} ${msg.left === 1 ? 'try' : 'tries'} left.`);
      } else if (msg.type === 'paired') {
        const p = {
          laptopId: msg.laptopId,
          laptopName: msg.laptopName,
          secret: secret || msg.secret, // from the key swap (older laptops sent it)
          ip: info.ip,
          port: info.port,
          dport: info.dport || Number(info.port) + 2,
          deviceId,
          pairedAt: new Date().toISOString(),
        };
        await AsyncStorage.setItem(PAIRING_KEY, JSON.stringify(p));
        setMessage('');
        setLive(true);
        setPairing(p);
        setScreen('paired');
        sendClipboard();
      } else if (msg.type === 'error') {
        goHome(msg.message);
      }
    };

    ws.onerror = () => {};
    ws.onclose = () => {
      clearTimeout(timeout);
      if (wsRef.current === ws) goHome('Lost connection to the laptop. Scan the QR code again.');
    };
  };

  // Emulator only: pairing link from the laptop test copy (same data as the QR code)
  const screenRef = useRef(screen);
  screenRef.current = screen;
  useEffect(() => {
    if (!IS_EMULATOR) return;
    const handle = (url) => {
      const m = /^simpleapp:\/\/pair\?data=(.+)$/.exec(url || '');
      if (!m || screenRef.current !== 'home') return;
      try {
        const info = JSON.parse(decodeURIComponent(m[1]));
        if (info.app === 'simple' && info.ip && info.port && info.token) startPairing(info);
      } catch {}
    };
    const sub = Linking.addEventListener('url', (e) => handle(e.url));
    return () => sub.remove();
  }, []);

  // Step 2: send OTP
  const sendOtp = () => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && otp.length === 6) {
      setMessage('');
      ws.send(JSON.stringify({ type: 'otp', code: otp }));
    }
  };

  const forget = async (text = '') => {
    await AsyncStorage.removeItem(PAIRING_KEY);
    if (NATIVE_SYNC) SimpleClipboard.stop();
    setPopup(null);
    setLive(false);
    lastClipRef.current = null;
    setPairing(null);
    goHome(text);
  };

  // Paired: keep a live connection to the laptop, reconnect if it drops,
  // and auto-find the laptop if its Wi-Fi address changed.
  useEffect(() => {
    if (screen !== 'paired' || !pairing) return;
    let stopped = false;
    let retry = null;
    let failures = 0;

    // The laptop moved to a new address? Ask the background service, then the network.
    const findLaptop = async () => {
      try {
        let found = null;
        const known = SimpleClipboard.laptopAddress();
        if (known && (known.ip !== pairing.ip || Number(known.port) !== Number(pairing.port))) found = known;
        if (!found) {
          found = await SimpleClipboard.findLaptop(pairing.laptopId, pairing.secret, discoveryPortOf(pairing), pairing.ip);
        }
        if (stopped) return;
        if (found && (found.ip !== pairing.ip || Number(found.port) !== Number(pairing.port))) {
          const updated = { ...pairing, ip: found.ip, port: Number(found.port) };
          await AsyncStorage.setItem(PAIRING_KEY, JSON.stringify(updated));
          setPairing(updated); // reconnects at the new address
          return;
        }
      } catch {}
      if (!stopped) retry = setTimeout(connect, 3000);
    };

    const connect = () => {
      if (stopped) return;
      let ws = wsRef.current;
      if (!ws || ws.readyState > WebSocket.OPEN) {
        ws = new WebSocket(`ws://${pairing.ip}:${pairing.port}`);
        wsRef.current = ws;
      }
      ws.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        // Sign in: answer the laptop's challenge with a proof (the secret is never sent).
        if (msg.type === 'challenge') {
          if (NATIVE_SYNC) {
            const { nonce, proof } = SimpleClipboard.signIn(pairing.secret, msg.nonce, 'app');
            ws.send(JSON.stringify({ type: 'reconnect', deviceId: pairing.deviceId, client: 'app', nonce, proof }));
          } else {
            ws.send(JSON.stringify({ type: 'reconnect', deviceId: pairing.deviceId, secret: pairing.secret }));
          }
        }
        if (msg.type === 'reconnected') {
          failures = 0;
          setLive(true);
          sendClipboardSoon();
        }
        if (msg.type === 'clipboard') receiveClipboard(msg.text);
        if (msg.type === 'unpaired') {
          stopped = true;
          forget('The laptop unpaired this phone.');
        }
      };
      ws.onerror = () => {};
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        setLive(false);
        if (stopped) return;
        failures++;
        if (NATIVE_SYNC && pairing.laptopId && failures % 2 === 0) findLaptop();
        else retry = setTimeout(connect, 3000);
      };
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      closeSocket();
    };
  }, [screen, pairing]);

  const unpair = () => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      // The connection is signed in, so no secret is needed (Expo Go still sends it).
      ws.send(
        JSON.stringify({ type: 'unpair', deviceId: pairing.deviceId, ...(NATIVE_SYNC ? {} : { secret: pairing.secret }) })
      );
    }
    forget();
  };

  // ---------- screens ----------

  if (screen === 'scan') {
    return (
      <>
        <StatusBar style="light" />
        <Scanner onScanned={startPairing} onCancel={() => goHome()} />
      </>
    );
  }

  let body = null;

  if (screen === 'loading' || screen === 'connecting') {
    body = (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#4f5bd5" />
        {screen === 'connecting' && <Text style={[styles.muted, { marginTop: 16 }]}>Connecting to laptop…</Text>}
      </View>
    );
  } else if (screen === 'home') {
    body = (
      <View style={styles.center}>
        <Text style={styles.title}>Pair with your laptop</Text>
        <Text style={styles.muted}>Open Simple on your laptop, then scan the QR code it shows.</Text>
        {message ? <Text style={styles.error}>{message}</Text> : null}
        <Button title="Scan QR code" onPress={() => { setMessage(''); setScreen('scan'); }} />
      </View>
    );
  } else if (screen === 'otp') {
    body = (
      <KeyboardAvoidingView style={styles.center} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Text style={styles.title}>Enter the code</Text>
        <Text style={styles.muted}>Type the 6-digit code shown on your laptop.</Text>
        <TextInput
          style={styles.otpInput}
          value={otp}
          onChangeText={(t) => setOtp(t.replace(/\D/g, '').slice(0, 6))}
          keyboardType="number-pad"
          maxLength={6}
          autoFocus
          placeholder="000000"
          placeholderTextColor="#c4c7d4"
          onSubmitEditing={sendOtp}
        />
        {message ? <Text style={styles.error}>{message}</Text> : null}
        <Button title="Pair" onPress={sendOtp} disabled={otp.length !== 6} />
        <Button title="Cancel" kind="secondary" onPress={() => goHome()} />
      </KeyboardAvoidingView>
    );
  } else if (screen === 'paired') {
    // Main screen after pairing: features go here
    body = (
      <View style={styles.main}>
        {/* Feature: clipboard sync */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={{ flexShrink: 1 }}>
              <Text style={styles.cardTitle}>Clipboard sync</Text>
              <Text style={styles.cardSub}>Copy on one device, paste on the other.</Text>
            </View>
            <Switch
              value={clipSync}
              onValueChange={toggleClipSync}
              trackColor={{ false: '#c9ccd8', true: '#4f5bd5' }}
              thumbColor="#fff"
            />
          </View>
        </View>

        {/* Feature: Simple Drop (installed app only) */}
        {NATIVE_SYNC ? (
          <View style={[styles.card, styles.cardGap]}>
            <View style={styles.cardHeader}>
              <View style={{ flexShrink: 1 }}>
                <Text style={styles.cardTitle}>Simple Drop</Text>
                <Text style={styles.cardSub}>Share photos and files to "Simple Drop" to send them to your laptop.</Text>
              </View>
              <Switch
                value={dropOn}
                onValueChange={toggleDrop}
                trackColor={{ false: '#c9ccd8', true: '#4f5bd5' }}
                thumbColor="#fff"
              />
            </View>
            {/* No location yet: pick one right away. Location set: only the change link
                (the location itself is shown in the popup). */}
            {dropFolder ? (
              <Pressable onPress={() => setPopup('drop')} hitSlop={8} style={({ pressed }) => [pressed && { opacity: 0.6 }]}>
                <Text style={styles.changeLink}>Do you want to change the location?</Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={pickDropLocation}
                style={({ pressed }) => [styles.locationRow, pressed && { opacity: 0.6 }]}
              >
                <Text style={styles.locationText}>Select your drop location</Text>
              </Pressable>
            )}
          </View>
        ) : null}
      </View>
    );
  }

  const isPaired = screen === 'paired';

  const confirmUnpair = () =>
    Alert.alert('Unpair', 'Unpair this phone from the laptop?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Unpair',
        style: 'destructive',
        onPress: () => {
          setPopup(null);
          unpair();
        },
      },
    ]);

  return (
    <View style={styles.container}>
      <StatusBar style="dark" />
      <View style={[styles.header, isPaired && styles.headerBar]}>
        <View style={styles.brandRow}>
          <Pressable
            onPress={() => isPaired && setPopup('menu')}
            disabled={!isPaired}
            hitSlop={10}
            style={({ pressed }) => [styles.logo, pressed && { opacity: 0.7 }]}
          >
            <Text style={styles.logoText}>S</Text>
          </Pressable>
          <Text style={styles.brand}>Simple</Text>
        </View>
        {isPaired && (
          <Pressable onPress={() => setPopup('device')} hitSlop={16} style={styles.dotButton}>
            <View style={[styles.dot, styles.dotBig, connected && styles.dotOn]} />
          </Pressable>
        )}
      </View>
      {body}

      {/* Logo popup: menu with Unpair */}
      <Popup visible={isPaired && popup === 'menu'} title="Simple" onClose={() => setPopup(null)}>
        <Pressable onPress={confirmUnpair} style={({ pressed }) => [styles.popupItem, pressed && { opacity: 0.6 }]}>
          <Text style={[styles.popupItemText, styles.dangerText]}>Unpair</Text>
        </Pressable>
      </Popup>

      {/* Simple Drop popup: change location */}
      <Popup visible={isPaired && popup === 'drop'} title="Drop location" onClose={() => setPopup(null)}>
        <InfoRow label="Current location" value={dropFolder?.name || '-'} />
        <Pressable
          onPress={async () => {
            if (await pickDropLocation()) setPopup(null);
          }}
          style={({ pressed }) => [styles.popupItem, styles.popupItemPrimary, pressed && { opacity: 0.6 }]}
        >
          <Text style={[styles.popupItemText, styles.primaryText]}>Change location</Text>
        </Pressable>
      </Popup>

      {/* Green dot popup: connected device info */}
      <Popup visible={isPaired && popup === 'device'} title="Connected device" onClose={() => setPopup(null)}>
        <InfoRow label="Name" value={pairing?.laptopName || 'Laptop'} />
        <InfoRow
          label="Status"
          value={
            <View style={styles.statusInline}>
              <View style={[styles.dot, connected && styles.dotOn]} />
              <Text style={styles.infoValue}>{connected ? 'Connected' : 'Not connected'}</Text>
            </View>
          }
        />
        <InfoRow label="Address" value={pairing ? `${pairing.ip}:${pairing.port}` : '-'} />
        {pairing?.pairedAt ? <InfoRow label="Paired on" value={new Date(pairing.pairedAt).toLocaleString()} /> : null}
      </Popup>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f6f7fb' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingTop: 56,
    paddingBottom: 12,
    paddingHorizontal: 20,
  },
  headerBar: { borderBottomWidth: 1, borderBottomColor: '#e3e5ee' },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dotButton: { padding: 6 },
  dotBig: { width: 14, height: 14, borderRadius: 7 },
  main: { flex: 1, padding: 16 },
  card: { backgroundColor: '#fff', borderRadius: 16, borderWidth: 1, borderColor: '#e3e5ee', padding: 18 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  cardTitle: { fontSize: 17, fontWeight: '700', color: '#1b1d29', marginBottom: 2 },
  cardSub: { fontSize: 13, color: '#6b7084' },
  cardGap: { marginTop: 14 },
  locationRow: {
    marginTop: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#c9ccd8',
    backgroundColor: '#f6f7fb',
  },
  locationText: { fontSize: 14, fontWeight: '600', color: '#4f5bd5' },
  backdrop: { flex: 1, backgroundColor: 'rgba(20,22,35,0.45)', justifyContent: 'center', padding: 24 },
  popup: { backgroundColor: '#fff', borderRadius: 18, padding: 20 },
  popupHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  popupTitle: { fontSize: 18, fontWeight: '700', color: '#1b1d29' },
  closeBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#f0f1f6', alignItems: 'center', justifyContent: 'center' },
  closeText: { fontSize: 16, color: '#6b7084', fontWeight: '600' },
  popupItem: { paddingVertical: 14, paddingHorizontal: 12, borderRadius: 12, backgroundColor: '#fdf3f3' },
  popupItemText: { fontSize: 16, fontWeight: '600' },
  popupItemPrimary: { marginTop: 12, backgroundColor: '#eef0fb' },
  primaryText: { color: '#4f5bd5' },
  changeLink: { marginTop: 14, fontSize: 13, fontWeight: '600', color: '#4f5bd5' },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#eef0f5', gap: 12 },
  infoLabel: { fontSize: 14, color: '#6b7084' },
  infoValue: { fontSize: 14, fontWeight: '600', color: '#1b1d29', flexShrink: 1, textAlign: 'right' },
  statusInline: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  logo: { width: 32, height: 32, borderRadius: 9, backgroundColor: '#4f5bd5', alignItems: 'center', justifyContent: 'center' },
  logoText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  brand: { fontSize: 18, fontWeight: '600', color: '#1b1d29' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#f6f7fb' },
  title: { fontSize: 24, fontWeight: '700', color: '#1b1d29', textAlign: 'center', marginBottom: 8 },
  muted: { fontSize: 15, color: '#6b7084', textAlign: 'center' },
  error: { fontSize: 14, color: '#d64545', textAlign: 'center', marginTop: 16 },
  button: { marginTop: 16, minWidth: 220, paddingVertical: 14, paddingHorizontal: 24, borderRadius: 12, alignItems: 'center' },
  primary: { backgroundColor: '#4f5bd5' },
  secondary: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#e3e5ee' },
  danger: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#f0c9c9' },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  buttonTextDark: { color: '#1b1d29' },
  dangerText: { color: '#d64545' },
  otpInput: {
    marginTop: 24,
    width: 240,
    paddingVertical: 14,
    fontSize: 32,
    fontWeight: '700',
    letterSpacing: 8,
    textAlign: 'center',
    color: '#4f5bd5',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e3e5ee',
    borderRadius: 14,
  },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#b9bccb' },
  dotOn: { backgroundColor: '#22a55b' },
  scanner: { flex: 1, backgroundColor: '#000' },
  scanOverlay: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  scanText: { color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 24, textAlign: 'center' },
  frame: { width: 250, height: 250, borderWidth: 3, borderColor: '#fff', borderRadius: 20 },
  scanHint: { color: '#ffd166', marginTop: 16, fontSize: 14 },
  scanCancel: { position: 'absolute', bottom: 56, paddingVertical: 12, paddingHorizontal: 28, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.15)' },
  scanCancelText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
