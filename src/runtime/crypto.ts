// AES-GCM credential encryption. Worker A owns this file's behaviour; the
// integrator owns the interface.
//
// Design points that matter:
// - The account id is bound as additional authenticated data, so a ciphertext
//   cannot be moved between accounts even by an attacker with database access.
// - The key version travels with the ciphertext, enabling rotation.
// - Failures are explicit. Tampered payloads throw rather than returning
//   plausible-looking plaintext.

export interface EncryptedCredential {
  ciphertext: string;
  iv: string;
  keyVersion: number;
}

export interface CredentialKeyring {
  activeVersion: number;
  keys: ReadonlyMap<number, CryptoKey>;
}

function requireKey(keyring: CredentialKeyring, version: number): CryptoKey {
  const key = keyring.keys.get(version);
  if (!key) throw new Error(`No credential key for version ${version}`);
  return key;
}

function toAad(accountId: string, keyVersion: number): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(
    `jevmail:credential:${accountId}:v${keyVersion}`,
  );
  return new Uint8Array(encoded.buffer as ArrayBuffer);
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeBase64Url(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function importCredentialKey(raw: string): Promise<CryptoKey> {
  const bytes = decodeBase64Url(raw);
  if (bytes.byteLength !== 32) {
    throw new Error(`Credential key must be 32 bytes, got ${bytes.byteLength}`);
  }
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptCredential(
  plaintext: string,
  accountId: string,
  keyring: CredentialKeyring,
): Promise<EncryptedCredential> {
  const keyVersion = keyring.activeVersion;
  const key = requireKey(keyring, keyVersion);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: toAad(accountId, keyVersion) },
    key,
    new TextEncoder().encode(plaintext),
  );
  return {
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
    iv: encodeBase64Url(iv),
    keyVersion,
  };
}

export async function decryptCredential(
  payload: EncryptedCredential,
  accountId: string,
  keyring: CredentialKeyring,
): Promise<string> {
  const key = requireKey(keyring, payload.keyVersion);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: decodeBase64Url(payload.iv),
      additionalData: toAad(accountId, payload.keyVersion),
    },
    key,
    decodeBase64Url(payload.ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}
