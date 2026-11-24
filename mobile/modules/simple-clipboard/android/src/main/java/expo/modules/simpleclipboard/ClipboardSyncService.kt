package expo.modules.simpleclipboard

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.provider.OpenableColumns
import android.util.Log
import android.widget.Toast
import androidx.core.app.NotificationCompat
import androidx.documentfile.provider.DocumentFile
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.io.OutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Runs in the background (with a small "Simple" notification) while the phone is paired and
 * Clipboard sync and/or Simple Drop is on.
 *
 * Clipboard sync
 *  - Laptop -> phone: text from the laptop is put on the phone clipboard.
 *  - Phone -> laptop: Android blocks background apps from reading the clipboard, so
 *    CopyWatchService (accessibility) or the log watcher (if READ_LOGS is granted) notices a copy and
 *    opens ClipboardFloatingActivity for a split second to read the new text.
 *
 * Simple Drop
 *  - Phone -> laptop: files shared to "Simple Drop" (ShareReceiverActivity) are streamed to the laptop.
 *  - Laptop -> phone: files from the laptop are saved in the folder the user picked.
 *  Protocol: drop_start (JSON) -> drop_accept/drop_reject -> binary chunks -> drop_end -> drop_done/drop_error
 */
class ClipboardSyncService : Service() {
  companion object {
    private const val TAG = "SimpleClipboard"
    private const val CHANNEL_ID = "clipboard_sync"
    private const val DROP_CHANNEL_ID = "simple_drop"
    private const val NOTIFICATION_ID = 4210
    private const val MAX_CLIP = 200_000
    private const val RECONNECT_MS = 3000L
    private const val CHUNK = 256 * 1024
    private const val MAX_QUEUE = 4L * 1024 * 1024
    const val ACTION_SHARE = "expo.modules.simpleclipboard.SHARE"

    @Volatile var running = false
    @Volatile var instance: ClipboardSyncService? = null
  }

  private val main = Handler(Looper.getMainLooper())
  private val http = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
  private lateinit var clipboard: ClipboardManager

  @Volatile private var config: SyncConfig? = null
  @Volatile private var socket: WebSocket? = null
  @Volatile private var connected = false
  @Volatile private var key: ByteArray? = null // encryption key for the current connection (after sign-in)
  private var failures = 0 // connection attempts in a row that failed
  private val finder = Executors.newSingleThreadExecutor()
  private var status: String? = null // shown in the notification while sending

  // clipboard
  private var lastClip: String? = null // last text synced either way (stops echo loops)
  private var pendingText: String? = null // copied while the laptop was away
  private var selfWriteAt = 0L // when we last wrote to the clipboard ourselves
  private var lastReaderLaunch = 0L
  private var logThread: Thread? = null
  private var logProcess: Process? = null

  // Simple Drop
  private class Incoming(val id: String, val name: String, val mime: String, val doc: DocumentFile, val out: OutputStream)
  private val dropLock = Any()
  private var incoming: Incoming? = null
  private val sender = Executors.newSingleThreadExecutor()
  private val waiters = ConcurrentHashMap<String, LinkedBlockingQueue<JSONObject>>()
  private var dropNotificationId = 5000

  val clipboardOn get() = config?.clipboardOn == true

  private val reconnectRunnable = Runnable { connect() }

  // Fires directly when the app is on screen. In the background Android blocks it.
  private val clipListener = ClipboardManager.OnPrimaryClipChangedListener {
    if (!clipboardOn || SystemClock.elapsedRealtime() - selfWriteAt < 1500) return@OnPrimaryClipChangedListener
    readClipboard()?.let { sendText(it) }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
    startAsForeground()
    instance = this
    running = true
    clipboard.addPrimaryClipChangedListener(clipListener)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    startAsForeground()
    val newConfig = SyncConfig.load(this)
    if (newConfig == null) {
      stopSelf()
      return START_NOT_STICKY
    }
    val reconnect = !newConfig.sameLaptop(config)
    config = newConfig
    if (reconnect) connect() else updateNotification()

    if (newConfig.clipboardOn && logThread?.isAlive != true) startLogWatcher()
    if (!newConfig.clipboardOn) stopLogWatcher()

    if (intent?.action == ACTION_SHARE) handleShare(intent)
    return START_STICKY
  }

  override fun onDestroy() {
    running = false
    instance = null
    config = null
    main.removeCallbacksAndMessages(null)
    clipboard.removePrimaryClipChangedListener(clipListener)
    stopLogWatcher()
    dropAbort()
    failWaiters()
    sender.shutdownNow()
    finder.shutdownNow()
    socket?.close(1000, null)
    socket = null
    super.onDestroy()
  }

  // ---------- notifications & toasts ----------

  private fun featureText(): String {
    val c = config
    return when {
      c == null -> "Simple"
      c.clipboardOn && c.dropOn -> "Clipboard sync and Simple Drop are on"
      c.dropOn -> "Simple Drop is on"
      else -> "Clipboard sync is on"
    }
  }

  private fun openAppIntent() = packageManager.getLaunchIntentForPackage(packageName)?.let {
    PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  private fun buildNotification() = NotificationCompat.Builder(this, CHANNEL_ID)
    .setContentTitle("Simple")
    .setContentText(status ?: if (connected) featureText() else "Looking for your laptop…")
    .setSmallIcon(applicationInfo.icon)
    .setOngoing(true)
    .setPriority(NotificationCompat.PRIORITY_LOW)
    .setContentIntent(openAppIntent())
    .build()

  private fun startAsForeground() {
    val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= 26) {
      nm.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Simple running", NotificationManager.IMPORTANCE_LOW))
      nm.createNotificationChannel(NotificationChannel(DROP_CHANNEL_ID, "Simple Drop", NotificationManager.IMPORTANCE_DEFAULT))
    }
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(NOTIFICATION_ID, buildNotification())
    }
  }

  private fun updateNotification() {
    main.post {
      if (!running) return@post
      (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIFICATION_ID, buildNotification())
    }
  }

  private fun setConnected(value: Boolean) {
    if (connected == value) return
    connected = value
    updateNotification()
  }

  private fun setStatus(text: String?) {
    main.post {
      status = text
      updateNotification()
    }
  }

  private fun toast(text: String) {
    main.post { Toast.makeText(applicationContext, text, Toast.LENGTH_LONG).show() }
  }

  // Tap the notification to open the received file.
  private fun notifyReceived(name: String, mime: String, uri: Uri) {
    val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime)
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    val n = NotificationCompat.Builder(this, DROP_CHANNEL_ID)
      .setContentTitle("Simple Drop")
      .setContentText("Received $name")
      .setSmallIcon(applicationInfo.icon)
      .setAutoCancel(true)
      .setContentIntent(PendingIntent.getActivity(this, dropNotificationId, view, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
      .build()
    (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(dropNotificationId++, n)
  }

  // ---------- connection to the laptop ----------

  private fun connect() {
    main.removeCallbacks(reconnectRunnable)
    socket?.cancel()
    socket = null
    key = null
    setConnected(false)
    val c = config ?: return
    val request = Request.Builder().url("ws://${c.ip}:${c.port}").build()
    socket = http.newWebSocket(request, object : WebSocketListener() {
      // Before sign-in: plain messages. The laptop starts with a random challenge.
      override fun onMessage(webSocket: WebSocket, text: String) {
        if (webSocket !== socket || key != null) return // once encrypted, plain text is ignored
        val msg = try { JSONObject(text) } catch (e: Exception) { return }
        when (msg.optString("type")) {
          "challenge" -> signIn(webSocket, c, msg.optString("nonce"))
          "unpaired" -> main.post { handleMessage(webSocket, msg) } // laptop doesn't know us anymore
        }
      }

      // After sign-in: every frame is encrypted. Runs on OkHttp's reader thread, in order, so
      // file messages are handled right here (in order with the chunks); the rest on the main thread.
      override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
        if (webSocket !== socket) return
        val k = key ?: return
        val (kind, payload) = try {
          SimpleCrypto.open(k, bytes.toByteArray())
        } catch (e: Exception) {
          webSocket.cancel() // wrong key or tampered: drop the connection
          return
        }
        if (kind == SimpleCrypto.KIND_CHUNK) return dropChunk(webSocket, payload)
        val msg = try { JSONObject(String(payload)) } catch (e: Exception) { return }
        when (msg.optString("type")) {
          "drop_start" -> dropStart(webSocket, msg)
          "drop_end" -> dropEnd(webSocket, msg)
          "drop_accept", "drop_reject", "drop_done", "drop_error" -> waiters[msg.optString("id")]?.offer(msg)
          else -> main.post { handleMessage(webSocket, msg) }
        }
      }

      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = gone(webSocket)

      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = gone(webSocket)

      private fun gone(webSocket: WebSocket) {
        if (webSocket !== socket) return
        dropAbort()
        failWaiters()
        main.post { socketGone(webSocket) }
      }
    })
  }

  // Prove we know the secret (without sending it) and switch this connection to encryption.
  private fun signIn(webSocket: WebSocket, c: SyncConfig, challenge: String) {
    try {
      val n1 = SimpleCrypto.unb64(challenge)
      val n2 = SimpleCrypto.randomBytes(16)
      webSocket.send(
        JSONObject().put("type", "reconnect").put("deviceId", c.deviceId).put("client", "service")
          .put("nonce", SimpleCrypto.b64(n2)).put("proof", SimpleCrypto.authProof(c.secret, n1, n2, "service"))
          .toString()
      )
      key = SimpleCrypto.sessionKey(c.secret, n1, n2) // the laptop's "reconnected" arrives encrypted
    } catch (e: Exception) {
      webSocket.cancel()
    }
  }

  // Encrypted after sign-in; plain only before it.
  private fun sendJson(ws: WebSocket, msg: JSONObject): Boolean {
    val k = key ?: return ws.send(msg.toString())
    return ws.send(SimpleCrypto.seal(k, SimpleCrypto.KIND_JSON, msg.toString().toByteArray()).toByteString())
  }

  private fun sendChunk(ws: WebSocket, buf: ByteArray, length: Int): Boolean {
    val k = key ?: return false
    return ws.send(SimpleCrypto.seal(k, SimpleCrypto.KIND_CHUNK, buf, 0, length).toByteString())
  }

  private fun socketGone(webSocket: WebSocket) {
    if (webSocket !== socket) return
    socket = null
    key = null
    setConnected(false)
    if (config == null) return
    failures++
    // Every 2nd failure in a row: maybe the laptop's Wi-Fi address changed, so look for it.
    if (failures % 2 == 0) findLaptop() else main.postDelayed(reconnectRunnable, RECONNECT_MS)
  }

  private fun findLaptop() {
    val c = config ?: return
    try {
      finder.execute {
        val found = Discovery.find(c.laptopId, c.secret, c.discoveryPort, c.ip)
        main.post {
          val current = config ?: return@post
          if (found != null && (found.ip != current.ip || found.port != current.port)) {
            Log.i(TAG, "Laptop found at a new address")
            val updated = current.copy(ip = found.ip, port = found.port)
            config = updated
            SyncConfig.save(this, updated)
            SyncConfig.setFound(this, true)
            connect()
          } else {
            main.postDelayed(reconnectRunnable, RECONNECT_MS)
          }
        }
      }
    } catch (e: Exception) {
      main.postDelayed(reconnectRunnable, RECONNECT_MS)
    }
  }

  private fun handleMessage(webSocket: WebSocket, msg: JSONObject) {
    if (webSocket !== socket) return
    when (msg.optString("type")) {
      "reconnected" -> {
        failures = 0
        Log.i(TAG, "Signed in to laptop (encrypted)")
        setConnected(true)
        pendingText?.let { pendingText = null; sendText(it) }
      }
      "clipboard" -> {
        val text = msg.optString("text")
        if (clipboardOn && text.isNotEmpty() && text != lastClip) {
          lastClip = text
          selfWriteAt = SystemClock.elapsedRealtime()
          clipboard.setPrimaryClip(ClipData.newPlainText("Simple", text))
        }
      }
      "unpaired" -> {
        SyncConfig.clear(this)
        stopSelf()
      }
    }
  }

  // ---------- clipboard: phone -> laptop ----------

  private fun readClipboard(): String? = try {
    clipboard.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)?.toString()
  } catch (e: Exception) {
    null
  }

  /** Called from the listener (app on screen) or from ClipboardFloatingActivity (background). */
  fun sendText(raw: String) {
    main.post {
      if (!clipboardOn) return@post
      val text = raw.take(MAX_CLIP)
      if (text.isEmpty() || text == lastClip) return@post
      val ws = socket
      if (!connected || ws == null) {
        pendingText = text // send when the laptop is back
        return@post
      }
      lastClip = text
      sendJson(ws, JSONObject().put("type", "clipboard").put("text", text))
    }
  }

  // Android just blocked us from reading the clipboard = something new was copied in another app.
  private fun onBlockedClipboardRead() {
    if (!clipboardOn) return
    val now = SystemClock.elapsedRealtime()
    if (now - selfWriteAt < 1500) return // that was our own write from the laptop
    if (now - lastReaderLaunch < 800) return // one copy can log several lines
    lastReaderLaunch = now
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

  private fun startLogWatcher() {
    if (checkSelfPermission(Manifest.permission.READ_LOGS) != PackageManager.PERMISSION_GRANTED) return
    val thread = Thread {
      try {
        val since = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US).format(Date())
        val process = Runtime.getRuntime().exec(arrayOf("logcat", "-T", since, "ClipboardService:E", "*:S"))
        logProcess = process
        process.inputStream.bufferedReader().useLines { lines ->
          for (line in lines) {
            if (Thread.currentThread().isInterrupted) break
            if (line.contains(packageName)) main.post { onBlockedClipboardRead() }
          }
        }
      } catch (e: Exception) {
        Log.w(TAG, "Log watcher stopped", e)
      }
    }
    thread.isDaemon = true
    thread.start()
    logThread = thread
  }

  private fun stopLogWatcher() {
    logThread?.interrupt()
    logProcess?.destroy()
    logThread = null
    logProcess = null
  }

  // ---------- Simple Drop: laptop -> phone ----------

  private fun reply(ws: WebSocket, type: String, id: String, field: String? = null, text: String? = null) {
    val msg = JSONObject().put("type", type).put("id", id)
    if (field != null) msg.put(field, text)
    sendJson(ws, msg)
  }

  private fun dropStart(ws: WebSocket, msg: JSONObject) {
    val id = msg.optString("id")
    val c = config
    if (c == null || !c.dropOn || c.dropUri == null) {
      return reply(ws, "drop_reject", id, "reason", "Simple Drop is off on the phone.")
    }
    dropAbort()
    try {
      val folder = DocumentFile.fromTreeUri(this, Uri.parse(c.dropUri))
      if (folder == null || !folder.canWrite()) {
        return reply(ws, "drop_reject", id, "reason", "The phone can't save to its drop location. Pick it again in Simple.")
      }
      val name = msg.optString("name").replace(Regex("[/\\\\:*?\"<>|\\u0000-\\u001f]"), "_").trim().ifEmpty { "file" }.take(180)
      val mime = msg.optString("mime").ifBlank { "application/octet-stream" }
      val doc = folder.createFile(mime, name)
        ?: return reply(ws, "drop_reject", id, "reason", "The phone couldn't create the file.")
      val out = contentResolver.openOutputStream(doc.uri)
      if (out == null) {
        doc.delete()
        return reply(ws, "drop_reject", id, "reason", "The phone couldn't create the file.")
      }
      synchronized(dropLock) { incoming = Incoming(id, doc.name ?: name, mime, doc, BufferedOutputStream(out, CHUNK)) }
      setStatus("Receiving $name…")
      reply(ws, "drop_accept", id)
    } catch (e: Exception) {
      Log.w(TAG, "drop_start failed", e)
      reply(ws, "drop_reject", id, "reason", "The phone couldn't save the file.")
    }
  }

  private fun dropChunk(ws: WebSocket, bytes: ByteArray) {
    synchronized(dropLock) {
      val inc = incoming ?: return
      try {
        inc.out.write(bytes)
      } catch (e: Exception) {
        reply(ws, "drop_error", inc.id, "message", "The phone ran out of space or couldn't save the file.")
        abortLocked()
      }
    }
  }

  private fun dropEnd(ws: WebSocket, msg: JSONObject) {
    val inc = synchronized(dropLock) {
      val current = incoming
      if (current == null || current.id != msg.optString("id")) return
      incoming = null
      current
    }
    try {
      inc.out.close()
      reply(ws, "drop_done", inc.id)
      setStatus(null)
      notifyReceived(inc.name, inc.mime, inc.doc.uri)
    } catch (e: Exception) {
      inc.doc.delete()
      setStatus(null)
      reply(ws, "drop_error", inc.id, "message", "The phone couldn't save the file.")
    }
  }

  private fun dropAbort() = synchronized(dropLock) { abortLocked() }

  private fun abortLocked() {
    val inc = incoming ?: return
    incoming = null
    try { inc.out.close() } catch (e: Exception) {}
    try { inc.doc.delete() } catch (e: Exception) {}
    setStatus(null)
  }

  // ---------- Simple Drop: phone -> laptop ----------

  private class SharedItem(val name: String, val size: Long, val mime: String, val open: () -> InputStream?)

  private fun handleShare(intent: Intent) {
    val clip = intent.clipData
    val uris = (0 until (clip?.itemCount ?: 0)).mapNotNull { clip?.getItemAt(it)?.uri }
    val text = intent.getStringExtra(Intent.EXTRA_TEXT)
    try {
      sender.execute { sendShared(uris, text) }
    } catch (e: Exception) {
      toast("Couldn't send to your laptop.")
    }
  }

  private fun itemFromUri(uri: Uri): SharedItem {
    var name: String? = null
    var size = -1L
    try {
      contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use {
        if (it.moveToFirst()) {
          name = it.getString(0)
          if (!it.isNull(1)) size = it.getLong(1)
        }
      }
    } catch (e: Exception) {}
    val mime = contentResolver.getType(uri) ?: "application/octet-stream"
    return SharedItem(name ?: uri.lastPathSegment ?: "file", size, mime) { contentResolver.openInputStream(uri) }
  }

  private fun itemFromText(text: String): SharedItem {
    val bytes = text.toByteArray()
    val stamp = SimpleDateFormat("yyyy-MM-dd HH.mm.ss", Locale.US).format(Date())
    return SharedItem("Shared text $stamp.txt", bytes.size.toLong(), "text/plain") { ByteArrayInputStream(bytes) }
  }

  private fun waitForConnection(timeoutMs: Long): Boolean {
    val end = SystemClock.elapsedRealtime() + timeoutMs
    if (!connected) main.post { if (socket == null) connect() }
    while (!connected && SystemClock.elapsedRealtime() < end) Thread.sleep(200)
    return connected
  }

  private fun sendShared(uris: List<Uri>, text: String?) {
    val items = when {
      uris.isNotEmpty() -> uris.map { itemFromUri(it) }
      !text.isNullOrEmpty() -> listOf(itemFromText(text))
      else -> return
    }
    if (!waitForConnection(15_000)) {
      toast("Couldn't reach your laptop. Make sure Simple is open on the laptop and you're on the same Wi-Fi.")
      return
    }
    var sent = 0
    for ((i, item) in items.withIndex()) {
      setStatus(if (items.size > 1) "Sending ${item.name} (${i + 1} of ${items.size})…" else "Sending ${item.name}…")
      val error = sendOne(item)
      if (error != null) {
        toast(error)
        break
      }
      sent++
    }
    setStatus(null)
    if (sent > 0) toast(if (sent == 1) "Sent to your laptop" else "Sent $sent files to your laptop")
  }

  /** Sends one file. Returns null when done, or a message saying what went wrong. */
  private fun sendOne(item: SharedItem): String? {
    val ws = socket ?: return "Lost connection to your laptop."
    val id = UUID.randomUUID().toString()
    val replies = LinkedBlockingQueue<JSONObject>()
    waiters[id] = replies
    try {
      sendJson(
        ws,
        JSONObject().put("type", "drop_start").put("id", id).put("name", item.name)
          .put("size", item.size).put("mime", item.mime)
      )
      val answer = replies.poll(15, TimeUnit.SECONDS) ?: return "Your laptop didn't answer."
      if (answer.optString("type") != "drop_accept") {
        return answer.optString("reason").ifEmpty { answer.optString("message").ifEmpty { "Your laptop didn't accept ${item.name}." } }
      }
      val input = item.open() ?: return "Couldn't open ${item.name}."
      input.use {
        val buf = ByteArray(CHUNK)
        while (true) {
          val n = it.read(buf)
          if (n < 0) break
          while (ws.queueSize() > MAX_QUEUE) {
            if (socket !== ws) return "Lost connection to your laptop."
            Thread.sleep(20)
          }
          if (!sendChunk(ws, buf, n)) return "Lost connection to your laptop."
        }
      }
      sendJson(ws, JSONObject().put("type", "drop_end").put("id", id))
      val done = replies.poll(120, TimeUnit.SECONDS) ?: return "Your laptop didn't answer."
      return if (done.optString("type") == "drop_done") null
      else done.optString("message").ifEmpty { "Couldn't send ${item.name}." }
    } catch (e: InterruptedException) {
      return "Sending was stopped."
    } catch (e: Exception) {
      Log.w(TAG, "send failed", e)
      return "Couldn't send ${item.name}."
    } finally {
      waiters.remove(id)
    }
  }

  // Connection lost: wake up anything waiting for the laptop's answer.
  private fun failWaiters() {
    val lost = JSONObject().put("type", "drop_error").put("message", "Lost connection to your laptop.")
    for (q in waiters.values) q.offer(lost)
  }
}
