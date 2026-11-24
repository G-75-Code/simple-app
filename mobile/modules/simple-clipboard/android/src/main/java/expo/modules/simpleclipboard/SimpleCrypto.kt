package expo.modules.simpleclipboard

import android.util.Base64
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Same security as the laptop (laptop/secure.js):
 *  - Pairing: ECDH P-256 key swap; the shared secret is never sent over Wi-Fi.
 *  - Sign-in: HMAC proof answering the laptop's random challenge.
 *  - Traffic: AES-256-GCM, fresh key per connection. Frame = nonce(12) + ciphertext + tag(16);
 *    first plaintext byte: 0 = JSON message, 1 = file chunk.
 */
object SimpleCrypto {
  const val KIND_JSON = 0
  const val KIND_CHUNK = 1

  private val random = SecureRandom()

  fun randomBytes(n: Int) = ByteArray(n).also { random.nextBytes(it) }
  fun b64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)
  fun unb64(text: String): ByteArray = Base64.decode(text, Base64.NO_WRAP)
  private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

  fun hmac(key: ByteArray, vararg parts: ByteArray): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(key, "HmacSHA256"))
    parts.forEach { mac.update(it) }
    return mac.doFinal()
  }

  // HKDF-SHA256 (RFC 5869), 32-byte output
  private fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray): ByteArray =
    hmac(hmac(salt, ikm), info, byteArrayOf(1))

  // ---------- pairing ----------

  fun newPairingKey(): KeyPair =
    KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()

  fun publicKeyB64(key: KeyPair) = b64(key.public.encoded) // X.509 SubjectPublicKeyInfo DER

  /** Shared secret (hex) from our key pair and the laptop's public key. */
  fun pairingSecret(key: KeyPair, laptopPubB64: String): String {
    val laptopPub = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(unb64(laptopPubB64)))
    val agreement = KeyAgreement.getInstance("ECDH")
    agreement.init(key.private)
    agreement.doPhase(laptopPub, true)
    return hex(hkdf(agreement.generateSecret(), "simple".toByteArray(), "pairing secret v1".toByteArray()))
  }

  // ---------- sign-in ----------

  fun authProof(secret: String, n1: ByteArray, n2: ByteArray, client: String): String =
    b64(hmac(secret.toByteArray(), "auth|".toByteArray(), n1, n2, "|$client".toByteArray()))

  fun sessionKey(secret: String, n1: ByteArray, n2: ByteArray): ByteArray =
    hkdf(secret.toByteArray(), n1 + n2, "simple session v1".toByteArray())

  fun hereProof(secret: String, nonce: ByteArray): String =
    b64(hmac(secret.toByteArray(), "here|".toByteArray(), nonce))

  // ---------- encrypted frames ----------

  fun seal(key: ByteArray, kind: Int, payload: ByteArray, offset: Int = 0, length: Int = payload.size): ByteArray {
    val nonce = randomBytes(12)
    val plain = ByteArray(1 + length)
    plain[0] = kind.toByte()
    System.arraycopy(payload, offset, plain, 1, length)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
    return nonce + cipher.doFinal(plain) // ciphertext + tag
  }

  /** Returns (kind, payload). Throws if the frame was tampered with or uses the wrong key. */
  fun open(key: ByteArray, frame: ByteArray): Pair<Int, ByteArray> {
    require(frame.size >= 12 + 1 + 16) { "frame too short" }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, frame, 0, 12))
    val plain = cipher.doFinal(frame, 12, frame.size - 12)
    return plain[0].toInt() to plain.copyOfRange(1, plain.size)
  }
}
