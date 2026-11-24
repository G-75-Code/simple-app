package expo.modules.simpleclipboard

import android.app.Activity
import android.content.ClipboardManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.WindowManager

/**
 * A tiny, invisible screen. Android only lets the app that has focus read the clipboard,
 * so the service opens this for a split second, it reads the copied text, and closes.
 */
class ClipboardFloatingActivity : Activity() {
  private val handler = Handler(Looper.getMainLooper())
  private var done = false

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // 1x1 pixel window in the corner; touches outside it go to the app underneath.
    window.addFlags(WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL)
    window.setLayout(1, 1)
    window.setGravity(Gravity.TOP or Gravity.START)
    // Safety net: never stay open if focus doesn't arrive.
    handler.postDelayed({ close() }, 2000)
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (!hasFocus || done) return
    val clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
    val text = try {
      clipboard.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)?.toString()
    } catch (e: Exception) {
      null
    }
    if (!text.isNullOrEmpty()) ClipboardSyncService.instance?.sendText(text)
    close()
  }

  private fun close() {
    if (done) return
    done = true
    handler.removeCallbacksAndMessages(null)
    finish()
    @Suppress("DEPRECATION")
    overridePendingTransition(0, 0)
  }
}
