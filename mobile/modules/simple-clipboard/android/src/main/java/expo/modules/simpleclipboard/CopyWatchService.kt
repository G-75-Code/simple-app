package expo.modules.simpleclipboard

import android.accessibilityservice.AccessibilityService
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.view.accessibility.AccessibilityEvent

/**
 * Accessibility helper (the user turns it on once in Settings > Accessibility).
 * It never reads screen content. It only watches for a "Copy" tap or a "Copied" message
 * in any app, then opens ClipboardFloatingActivity for a split second to read the new
 * clipboard text, because Android only lets the focused app read the clipboard.
 */
class CopyWatchService : AccessibilityService() {
  companion object {
    private const val TAG = "SimpleClipboard"
    // English + Hindi words for copy
    private val COPY_WORDS = Regex("""\b(copy|copied)\b|कॉपी""", RegexOption.IGNORE_CASE)

    fun isEnabled(context: Context): Boolean {
      val enabled = Settings.Secure.getString(
        context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
      ) ?: return false
      val full = ComponentName(context, CopyWatchService::class.java).flattenToString()
      val short = ComponentName(context, CopyWatchService::class.java).flattenToShortString()
      return enabled.split(':').any { it.equals(full, true) || it.equals(short, true) }
    }
  }

  private val handler = Handler(Looper.getMainLooper())
  private var lastTrigger = 0L

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    event ?: return
    if (event.packageName?.toString() == packageName) return // ignore Simple itself
    if (ClipboardSyncService.instance?.clipboardOn != true) return // clipboard sync switched off

    val words = buildString {
      event.text?.forEach { append(it).append(' ') }
      event.contentDescription?.let { append(it) }
    }
    if (words.isBlank() || words.length > 200 || !COPY_WORDS.containsMatchIn(words)) return

    val now = SystemClock.elapsedRealtime()
    if (now - lastTrigger < 800) return
    lastTrigger = now

    // Give the app a moment to actually put the text on the clipboard, then read it.
    handler.postDelayed({ openReader() }, 300)
  }

  private fun openReader() {
    try {
      startActivity(
        Intent(this, ClipboardFloatingActivity::class.java).addFlags(
          Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION or Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS
        )
      )
    } catch (e: Exception) {
      Log.w(TAG, "Could not open clipboard reader", e)
    }
  }

  override fun onInterrupt() {}
}
