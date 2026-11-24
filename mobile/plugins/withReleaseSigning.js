// Signs the release APK with Simple's own key (mobile/keystore/) instead of the shared debug key.
// The key and its passwords live in mobile/keystore/ - back that folder up: without it, future
// updates can't be installed over this app (Android checks the signature matches).
const { withAppBuildGradle } = require('expo/config-plugins');

const RELEASE_SIGNING = `
        release {
            // Simple's own signing key (see mobile/keystore/keystore.properties)
            def simpleKeystore = rootProject.file('../keystore/keystore.properties')
            if (simpleKeystore.exists()) {
                def p = new Properties()
                simpleKeystore.withInputStream { p.load(it) }
                storeFile rootProject.file('../keystore/' + p['storeFile'])
                storePassword p['storePassword']
                keyAlias p['keyAlias']
                keyPassword p['keyPassword']
            }
        }`;

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    let gradle = cfg.modResults.contents;
    if (!gradle.includes('simpleKeystore')) {
      // Add the release signing config next to the debug one
      gradle = gradle.replace(/signingConfigs\s*\{/, (m) => m + RELEASE_SIGNING);
      // Use it for release builds when the key exists (falls back to the debug key otherwise)
      gradle = gradle.replace(
        /(release\s*\{[^{}]*?)signingConfig signingConfigs\.debug/,
        "$1signingConfig rootProject.file('../keystore/keystore.properties').exists() ? signingConfigs.release : signingConfigs.debug"
      );
    }
    cfg.modResults.contents = gradle;
    return cfg;
  });
};
