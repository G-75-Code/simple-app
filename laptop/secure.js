// Security helpers shared by the laptop app. The phone (Kotlin, SimpleCrypto.kt) does exactly the same.
//
// Pairing:  both sides make a one-time P-256 key pair and swap public keys (ECDH). The shared
//           secret is computed on each side and never sent over Wi-Fi.
// Sign-in:  on every connection the laptop sends a random "challenge"; the phone answers with an
//           HMAC proof that it knows the secret (the secret itself is never sent).
// Traffic:  after sign-in, the phone's background service connection is encrypted with AES-256-GCM
//           using a fresh key for that connection. Frame = nonce(12) + ciphertext + tag(16).
//           Inside: first byte 0 = JSON message, 1 = file chunk.
const crypto = require('crypto');

const KIND_JSON = 0;
const KIND_CHUNK = 1;

const bytes = (p) => (Buffer.isBuffer(p) ? p : Buffer.from(String(p), 'utf8'));

function hmac(secret, ...parts) {
  const h = crypto.createHmac('sha256', Buffer.from(secret, 'utf8'));
  for (const p of parts) h.update(bytes(p));
  return h.digest();
}

const hkdf = (ikm, salt, info) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, 32));

// ---------- pairing (ECDH P-256) ----------

function newPairingKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKey, pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}

// Shared secret (hex string, same format as before) from our private key and the phone's public key.
function pairingSecret(privateKey, phonePubB64) {
  const publicKey = crypto.createPublicKey({ key: Buffer.from(phonePubB64, 'base64'), format: 'der', type: 'spki' });
  const shared = crypto.diffieHellman({ privateKey, publicKey });
  return hkdf(shared, Buffer.from('simple'), Buffer.from('pairing secret v1')).toString('hex');
}

// ---------- sign-in ----------

const authProof = (secret, n1, n2, client) => hmac(secret, 'auth|', n1, n2, `|${client}`).toString('base64');

const sessionKey = (secret, n1, n2) => hkdf(Buffer.from(secret, 'utf8'), Buffer.concat([n1, n2]), Buffer.from('simple session v1'));

// Discovery answer: proves this laptop knows the secret.
const hereProof = (secret, nonceB64) => hmac(secret, 'here|', Buffer.from(nonceB64, 'base64')).toString('base64');

// ---------- encrypted frames ----------

function seal(key, kind, payload) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(Buffer.from([kind])), cipher.update(payload), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

function open(key, frame) {
  if (frame.length < 12 + 1 + 16) throw new Error('frame too short');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, frame.subarray(0, 12));
  decipher.setAuthTag(frame.subarray(frame.length - 16));
  const plain = Buffer.concat([decipher.update(frame.subarray(12, frame.length - 16)), decipher.final()]);
  return { kind: plain[0], payload: plain.subarray(1) };
}

module.exports = { KIND_JSON, KIND_CHUNK, newPairingKey, pairingSecret, authProof, sessionKey, hereProof, seal, open };
