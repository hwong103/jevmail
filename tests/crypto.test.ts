import { describe, expect, it } from "vitest";
import {
  decryptCredential,
  encryptCredential,
  importCredentialKey,
  type CredentialKeyring,
} from "../src/runtime/crypto";

async function keyring(): Promise<CredentialKeyring> {
  const raw = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  return { activeVersion: 1, keys: new Map([[1, await importCredentialKey(raw)]]) };
}

describe("credential encryption", () => {
  it("round-trips", async () => {
    const keys = await keyring();
    const payload = await encryptCredential("refresh-token", "account-1", keys);
    expect(await decryptCredential(payload, "account-1", keys)).toBe("refresh-token");
  });

  it("fails when the account id differs", async () => {
    const keys = await keyring();
    const payload = await encryptCredential("refresh-token", "account-1", keys);
    await expect(decryptCredential(payload, "account-2", keys)).rejects.toThrow();
  });

  it("fails on tampered ciphertext", async () => {
    const keys = await keyring();
    const payload = await encryptCredential("refresh-token", "account-1", keys);
    // Flip a byte in the middle so the change cannot be a no-op re-encoding,
    // and assert the payload really differs before expecting a failure.
    const bytes = decodeBase64UrlForTest(payload.ciphertext);
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    const tampered = encodeBase64UrlForTest(bytes);
    expect(tampered).not.toBe(payload.ciphertext);
    await expect(
      decryptCredential({ ...payload, ciphertext: tampered }, "account-1", keys),
    ).rejects.toThrow();
  });

  it("rejects a key of the wrong length", async () => {
    const raw = btoa("short");
    await expect(importCredentialKey(raw)).rejects.toThrow(/32 bytes/);
  });
});

function decodeBase64UrlForTest(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeBase64UrlForTest(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
