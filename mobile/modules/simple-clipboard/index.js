import { requireOptionalNativeModule } from 'expo';

// Native background clipboard sync (Android, only in the installed Simple app).
// In Expo Go this is null and the app falls back to syncing while it is open.
export default requireOptionalNativeModule('SimpleClipboard');
