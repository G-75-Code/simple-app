package expo.modules.simpleclipboard

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.PowerManager
import android.provider.DocumentsContract
import android.provider.Settings
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val PICK_FOLDER_REQUEST = 47021

class SimpleClipboardModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React Application Context is null" }

  private var folderPromise: Promise? = null
  private var pairingKey: java.security.KeyPair? = null

  override fun definition() = ModuleDefinition {
    Name("SimpleClipboard")

    // Start (or refresh) the background service for the paired laptop with the chosen features.
    // cfg: { ip, port, deviceId, secret, laptopId, discoveryPort, clipboardOn, dropOn, dropUri }
    Function("start") { cfg: Map<String, Any?> ->
      val port = (cfg["port"] as? Number)?.toInt() ?: 0
      val saved = SyncConfig.load(context)
      val incoming = SyncConfig(
        ip = cfg["ip"] as? String ?: "",
        port = port,
        deviceId = cfg["deviceId"] as? String ?: "",
        secret = cfg["secret"] as? String ?: "",
        clipboardOn = cfg["clipboardOn"] as? Boolean ?: true,
        dropOn = cfg["dropOn"] as? Boolean ?: false,
        dropUri = (cfg["dropUri"] as? String)?.ifEmpty { null },
        laptopId = cfg["laptopId"] as? String ?: "",
        discoveryPort = (cfg["discoveryPort"] as? Number)?.toInt() ?: (port + 2),
      )
      // If the service already auto-found the laptop at a new address, keep that one
      // (the app screen may still have the old address).
      val keepFound = saved != null && SyncConfig.wasFound(context) && saved.deviceId == incoming.deviceId &&
        saved.secret == incoming.secret && saved.laptopId == incoming.laptopId
      val config = if (keepFound) incoming.copy(ip = saved!!.ip, port = saved.port) else incoming
      SyncConfig.save(context, config)
      if (!keepFound || incoming.ip == saved?.ip) SyncConfig.setFound(context, false)
      setShareTargetEnabled(config.dropOn && config.dropUri != null)
      ContextCompat.startForegroundService(context, Intent(context, ClipboardSyncService::class.java))
    }

    // Where the background service currently reaches the laptop (after auto-find), or null.
    Function("laptopAddress") {
      SyncConfig.load(context)?.let { mapOf("ip" to it.ip, "port" to it.port) }
    }

    // ---------- secure pairing & sign-in (used by the app screen) ----------

    // Step 1 of pairing: make a one-time key pair; returns our public key for the laptop.
    Function("createPairingKey") {
      val key = SimpleCrypto.newPairingKey()
      pairingKey = key
      SimpleCrypto.publicKeyB64(key)
    }

    // Step 2: combine with the laptop's public key -> shared secret (never sent over Wi-Fi).
    Function("finishPairing") { laptopPub: String ->
      val key = pairingKey ?: throw IllegalStateException("No pairing in progress")
      pairingKey = null
      SimpleCrypto.pairingSecret(key, laptopPub)
    }

    // Answer the laptop's sign-in challenge without sending the secret.
    Function("signIn") { secret: String, challenge: String, client: String ->
      val n2 = SimpleCrypto.randomBytes(16)
      mapOf(
        "nonce" to SimpleCrypto.b64(n2),
        "proof" to SimpleCrypto.authProof(secret, SimpleCrypto.unb64(challenge), n2, client)
      )
    }

    // Auto-find the laptop after its Wi-Fi address changed. Resolves { ip, port } or null.
    AsyncFunction("findLaptop") { laptopId: String, secret: String, discoveryPort: Int, lastIp: String ->
      Discovery.find(laptopId, secret, discoveryPort, lastIp.ifEmpty { null })?.let {
        mapOf("ip" to it.ip, "port" to it.port)
      }
    }

    // Stop everything (all features off or phone unpaired).
    Function("stop") {
      SyncConfig.clear(context)
      setShareTargetEnabled(false)
      context.stopService(Intent(context, ClipboardSyncService::class.java))
    }

    Function("isRunning") { ClipboardSyncService.running }

    // Simple Drop: open Android's folder picker. Resolves { uri, name } or null if cancelled.
    AsyncFunction("pickDropFolder") { promise: Promise ->
      folderPromise?.resolve(null)
      folderPromise = promise
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(
        Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
          Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
      )
      appContext.throwingActivity.startActivityForResult(intent, PICK_FOLDER_REQUEST)
    }

    OnActivityResult { _, payload ->
      if (payload.requestCode != PICK_FOLDER_REQUEST) return@OnActivityResult
      val promise = folderPromise ?: return@OnActivityResult
      folderPromise = null
      val uri = payload.data?.data
      if (payload.resultCode != Activity.RESULT_OK || uri == null) {
        promise.resolve(null)
        return@OnActivityResult
      }
      try {
        // Keep access to the folder after restarts.
        context.contentResolver.takePersistableUriPermission(
          uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        )
        promise.resolve(mapOf("uri" to uri.toString(), "name" to folderLabel(uri)))
      } catch (e: Exception) {
        promise.resolve(null)
      }
    }

    // Is the "Simple clipboard sync" accessibility helper turned on?
    Function("isCopyWatchOn") { CopyWatchService.isEnabled(context) }

    // Open Settings > Accessibility so the user can turn it on.
    Function("openCopyWatchSettings") {
      context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    // Which one-time permissions are in place.
    Function("permissions") {
      val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      mapOf(
        "readLogs" to (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_LOGS) == PackageManager.PERMISSION_GRANTED),
        "overlay" to Settings.canDrawOverlays(context),
        "batteryUnrestricted" to power.isIgnoringBatteryOptimizations(context.packageName)
      )
    }

    // Ask Android to stop putting Simple to sleep (OnePlus phones kill background apps quickly).
    Function("requestBatteryUnrestricted") {
      val intent = Intent(
        Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
        Uri.parse("package:${context.packageName}")
      ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }
  }

  // "Simple Drop" shows in the Share menu only while it is turned on.
  private fun setShareTargetEnabled(enabled: Boolean) {
    context.packageManager.setComponentEnabledSetting(
      ComponentName(context, ShareReceiverActivity::class.java),
      if (enabled) PackageManager.COMPONENT_ENABLED_STATE_ENABLED else PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
      PackageManager.DONT_KILL_APP
    )
  }

  // "primary:Download/Simple" -> "Download/Simple"
  private fun folderLabel(uri: Uri): String {
    val id = try { DocumentsContract.getTreeDocumentId(uri) } catch (e: Exception) { return uri.toString() }
    val parts = id.split(':', limit = 2)
    val path = parts.getOrNull(1).orEmpty()
    return when {
      parts[0] == "primary" && path.isEmpty() -> "Internal storage"
      parts[0] == "primary" -> path
      path.isEmpty() -> "SD card"
      else -> "SD card/$path"
    }
  }
}
