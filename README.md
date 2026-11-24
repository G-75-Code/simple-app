# Simple

Simple connects your Android phone and your Windows laptop over your home Wi-Fi.

- **Pairing:** scan a QR code on the laptop with the phone, then type the 6-digit code shown on the laptop.
- **Clipboard sync:** copy on one device, paste on the other. Works in the background.
- **Simple Drop:** share photos and files to "Simple Drop" on the phone, or drag files onto the laptop window. They are saved in a folder you choose on each device.
- **Reliable:** the laptop app runs in the system tray and starts with Windows. If the laptop's Wi-Fi address changes, the phone finds it again on its own.
- **Private:** everything stays on your local network (no cloud, no account). Pairing uses a key exchange, so the shared secret never travels over Wi-Fi, and all clipboard text and files are encrypted (AES-256-GCM).

## Download

Get the latest **Simple-x.y.z.apk** (Android) and **Simple-Setup-x.y.z.exe** (Windows) from the [Releases](../../releases) page.

- **Windows:** run the setup. Windows may warn that the publisher is unknown: click *More info → Run anyway*.
- **Android:** open the APK and allow installing from that source. To sync what you copy while Simple is closed, turn on **Simple clipboard sync** in *Settings → Accessibility* (Simple asks you once). If it's greyed out: *Settings → Apps → Simple → ⋮ → Allow restricted settings*.

## How it works

| Part | Folder | Built with |
| --- | --- | --- |
| Laptop app | `laptop/` | Electron (Node.js) |
| Phone app | `mobile/` | React Native + Expo, with a native Android module in `mobile/modules/simple-clipboard/` (Kotlin) |
| Helper scripts | `tools/` | PowerShell / Node.js |

- The laptop runs a WebSocket server on port **8787** and answers "where is my laptop?" requests on UDP **8789**.
- On Android, a foreground service keeps the connection, writes text from the laptop to the clipboard, and sends files. Android does not let background apps read the clipboard, so an accessibility helper notices when you tap **Copy** and a tiny invisible screen reads the new text for a split second.
- Security details are in `laptop/secure.js` and `mobile/modules/simple-clipboard/android/.../SimpleCrypto.kt`: ECDH P-256 pairing, HMAC challenge sign-in, and AES-256-GCM for all content.

## Build it yourself

You need Node.js and, for the phone app, Android Studio (Android SDK + its bundled JDK).

**Laptop app**

```powershell
cd laptop
npm install
npm start          # run it
npm run dist       # build the Windows installer into laptop\dist\
```

**Phone app**

```powershell
cd mobile
npm install
npx expo prebuild --platform android
cd android
.\gradlew.bat assembleRelease   # APK in android\app\build\outputs\apk\release\
```

Release builds are signed with your own key if `mobile/keystore/keystore.properties` exists (see `mobile/plugins/withReleaseSigning.js`); otherwise the debug key is used. Keep your keystore private and backed up: Android only installs updates signed with the same key.

**Testing with the Android emulator**

`npm run start:test` (in `laptop/`) starts a separate test copy on port 8788 with its own data, so a real phone stays paired with the normal copy. `tools/pair-emulator.ps1` pairs the emulator with the test copy without a camera, and `tools/emu-tap.ps1` taps on-screen buttons by their text.

## License

[MIT](LICENSE)
