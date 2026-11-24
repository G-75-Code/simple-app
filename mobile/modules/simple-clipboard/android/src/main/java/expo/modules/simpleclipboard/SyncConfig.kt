package expo.modules.simpleclipboard

import android.content.Context

/**
 * Where the paired laptop is, how to sign in, and which features are on.
 * Saved so the background service can restart on its own.
 */
data class SyncConfig(
  val ip: String,
  val port: Int,
  val deviceId: String,
  val secret: String,
  val clipboardOn: Boolean,
  val dropOn: Boolean,
  val dropUri: String?, // folder picked for Simple Drop (Android folder access link)
  val laptopId: String, // for auto-find
  val discoveryPort: Int, // laptop's UDP auto-find port
) {
  /** True when the laptop connection details are the same (only feature switches changed). */
  fun sameLaptop(other: SyncConfig?) =
    other != null && ip == other.ip && port == other.port && deviceId == other.deviceId && secret == other.secret

  companion object {
    private const val PREFS = "simple_clipboard_sync"

    fun save(context: Context, config: SyncConfig) {
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        .putString("ip", config.ip)
        .putInt("port", config.port)
        .putString("deviceId", config.deviceId)
        .putString("secret", config.secret)
        .putBoolean("clipboardOn", config.clipboardOn)
        .putBoolean("dropOn", config.dropOn)
        .putString("dropUri", config.dropUri)
        .putString("laptopId", config.laptopId)
        .putInt("discoveryPort", config.discoveryPort)
        .apply()
    }

    fun load(context: Context): SyncConfig? {
      val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val ip = p.getString("ip", null) ?: return null
      val deviceId = p.getString("deviceId", null) ?: return null
      val secret = p.getString("secret", null) ?: return null
      val port = p.getInt("port", 0).takeIf { it > 0 } ?: return null
      return SyncConfig(
        ip, port, deviceId, secret,
        clipboardOn = p.getBoolean("clipboardOn", true),
        dropOn = p.getBoolean("dropOn", false),
        dropUri = p.getString("dropUri", null)?.takeIf { it.isNotEmpty() },
        laptopId = p.getString("laptopId", "") ?: "",
        discoveryPort = p.getInt("discoveryPort", port + 2),
      )
    }

    /** Set when the service auto-found the laptop at a new address. */
    fun setFound(context: Context, found: Boolean) {
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("found", found).apply()
    }

    fun wasFound(context: Context) =
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("found", false)

    fun clear(context: Context) {
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
    }
  }
}
