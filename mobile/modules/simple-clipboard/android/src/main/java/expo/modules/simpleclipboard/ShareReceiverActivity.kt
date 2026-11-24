package expo.modules.simpleclipboard

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.core.content.ContextCompat

/**
 * "Simple Drop" in the Android Share menu. Hands the shared photos/files to the background
 * service (which sends them to the laptop) and closes right away.
 */
class ShareReceiverActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    try {
      handle(intent)
    } finally {
      finish()
    }
  }

  private fun handle(intent: Intent?) {
    intent ?: return
    val config = SyncConfig.load(this)
    if (config == null || !config.dropOn || config.dropUri == null) {
      Toast.makeText(this, "Turn on Simple Drop in the Simple app first.", Toast.LENGTH_LONG).show()
      return
    }

    val uris = mutableListOf<Uri>()
    when (intent.action) {
      Intent.ACTION_SEND -> streamExtra(intent)?.let { uris.add(it) }
      Intent.ACTION_SEND_MULTIPLE -> uris.addAll(streamListExtra(intent))
    }
    val text = intent.getStringExtra(Intent.EXTRA_TEXT)
    if (uris.isEmpty() && text.isNullOrEmpty()) return

    // Pass the files on to the service, together with permission to read them.
    val service = Intent(this, ClipboardSyncService::class.java).setAction(ClipboardSyncService.ACTION_SHARE)
    if (uris.isNotEmpty()) {
      val clip = ClipData.newRawUri("Simple Drop", uris[0])
      uris.drop(1).forEach { clip.addItem(ClipData.Item(it)) }
      service.clipData = clip
      service.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    } else {
      service.putExtra(Intent.EXTRA_TEXT, text)
    }
    ContextCompat.startForegroundService(this, service)

    val count = if (uris.isNotEmpty()) uris.size else 1
    Toast.makeText(this, "Sending ${if (count == 1) "1 item" else "$count items"} to your laptop…", Toast.LENGTH_SHORT).show()
  }

  @Suppress("DEPRECATION")
  private fun streamExtra(intent: Intent): Uri? =
    if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    else intent.getParcelableExtra(Intent.EXTRA_STREAM)

  @Suppress("DEPRECATION")
  private fun streamListExtra(intent: Intent): List<Uri> =
    (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
    else intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)) ?: emptyList()
}
