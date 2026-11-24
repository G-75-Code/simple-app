package expo.modules.simpleclipboard

import android.os.Build
import android.os.SystemClock
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException

/**
 * Auto-find: if the laptop's Wi-Fi address changed, ask the local network "where is laptop <id>?"
 * (UDP broadcast). Only the real paired laptop can answer with a valid proof.
 * Must run on a background thread.
 */
object Discovery {
  data class Found(val ip: String, val port: Int)

  private val isEmulator: Boolean
    get() = Build.FINGERPRINT.contains("generic") || Build.FINGERPRINT.contains("emu") ||
      Build.MODEL.contains("sdk_gphone")

  fun find(laptopId: String, secret: String, udpPort: Int, lastIp: String?, timeoutMs: Long = 3500): Found? {
    if (laptopId.isEmpty() || udpPort <= 0) return null
    val nonce = SimpleCrypto.randomBytes(16)
    val nonceB64 = SimpleCrypto.b64(nonce)
    val request = JSONObject().put("type", "simple-discover").put("laptopId", laptopId).put("nonce", nonceB64)
      .toString().toByteArray()

    val targets = linkedSetOf<InetAddress>()
    runCatching { targets.add(InetAddress.getByName("255.255.255.255")) }
    runCatching {
      NetworkInterface.getNetworkInterfaces()?.toList()?.forEach { ni ->
        if (ni.isUp && !ni.isLoopback) ni.interfaceAddresses.forEach { ia -> ia.broadcast?.let { targets.add(it) } }
      }
    }
    lastIp?.let { ip -> runCatching { targets.add(InetAddress.getByName(ip)) } }
    if (isEmulator) runCatching { targets.add(InetAddress.getByName("10.0.2.2")) } // emulator's view of the PC

    return try {
      DatagramSocket().use { socket ->
        socket.broadcast = true
        socket.soTimeout = 400
        val buf = ByteArray(2048)
        val end = SystemClock.elapsedRealtime() + timeoutMs
        var lastSend = 0L
        while (SystemClock.elapsedRealtime() < end) {
          if (SystemClock.elapsedRealtime() - lastSend > 1000) {
            targets.forEach { t -> runCatching { socket.send(DatagramPacket(request, request.size, t, udpPort)) } }
            lastSend = SystemClock.elapsedRealtime()
          }
          val packet = DatagramPacket(buf, buf.size)
          try {
            socket.receive(packet)
          } catch (e: SocketTimeoutException) {
            continue
          }
          val msg = runCatching { JSONObject(String(packet.data, 0, packet.length)) }.getOrNull() ?: continue
          if (msg.optString("type") != "simple-here" || msg.optString("laptopId") != laptopId) continue
          if (msg.optString("nonce") != nonceB64 || msg.optString("proof") != SimpleCrypto.hereProof(secret, nonce)) continue
          val ip = packet.address?.hostAddress ?: continue
          return Found(ip, msg.optInt("port"))
        }
        null
      }
    } catch (e: Exception) {
      null
    }
  }
}
