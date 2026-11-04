// Per-group answers are stored encrypted (AES-256-GCM) only so they cannot be read at a glance;
// the site fetches and decrypts a group's answer after the group has been submitted.
const keys = new Map();

async function taskKey(b64) {
  if (!keys.has(b64)) {
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    keys.set(b64, crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']));
  }
  return keys.get(b64);
}

export async function decryptGroupAnswer(enc, keyB64) {
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(enc.iv) }, await taskKey(keyB64), b64(enc.ct));
  return JSON.parse(new TextDecoder().decode(plain));
}
