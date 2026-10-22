import { createCipheriv, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { needsSecretRotation, openSecret, sealSecret, validateEncryptionConfiguration } from "../lib/encryption.js";

const name = "SECRETS_ENCRYPTION_KEY";
const oldKey = "ab".repeat(32);
const newKey = "cd".repeat(32);
afterEach(() => vi.unstubAllEnvs());
function configure() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv(name, oldKey);
  vi.stubEnv(`${name}_ID`, "old");
  vi.stubEnv(`${name}_PREVIOUS_KEYS`, "");
}
function legacy(ivSize: number, prefix: string) {
  const iv = randomBytes(ivSize);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(oldKey, "hex"), iv);
  const encrypted = Buffer.concat([cipher.update("legacy secret"), cipher.final()]);
  return `${prefix}${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${encrypted.toString("hex")}`;
}
describe("authenticated at-rest encryption", () => {
  it("round-trips unicode and empty values with unique 96-bit nonces", () => {
    configure();
    for (const value of ["", "secret 🔐\nvalue"]) {
      const sealed = sealSecret(name, value);
      expect(sealed.split(":")[2]).toHaveLength(24);
      expect(openSecret(name, sealed)).toBe(value);
      expect(sealSecret(name, value)).not.toBe(sealed);
    }
  });
  it.each([[12, ""], [16, ""], [12, "v1:"]])("reads legacy %s-byte IV with prefix %s", (size, prefix) => {
    configure();
    expect(openSecret(name, legacy(size as number, prefix as string))).toBe("legacy secret");
  });
  it("retains old and legacy reads during rotation and retires old keys afterward", () => {
    configure();
    const old = sealSecret(name, "secret");
    const unversioned = legacy(16, "");
    vi.stubEnv(name, newKey);
    vi.stubEnv(`${name}_ID`, "new");
    vi.stubEnv(`${name}_PREVIOUS_KEYS`, JSON.stringify({ old: oldKey }));
    expect(openSecret(name, old)).toBe("secret");
    expect(openSecret(name, unversioned)).toBe("legacy secret");
    expect(needsSecretRotation(name, old)).toBe(true);
    const rotated = sealSecret(name, openSecret(name, old));
    expect(needsSecretRotation(name, rotated)).toBe(false);
    vi.stubEnv(`${name}_PREVIOUS_KEYS`, "");
    expect(openSecret(name, rotated)).toBe("secret");
    expect(() => openSecret(name, old)).toThrow();
  });
  it("rejects altered ciphertext, tag, key ID and malformed hex", () => {
    configure();
    const sealed = sealSecret(name, "secret");
    for (const index of [2, 3, 4]) {
      const parts = sealed.split(":");
      parts[index] = (parts[index]![0] === "0" ? "1" : "0") + parts[index]!.slice(1);
      expect(() => openSecret(name, parts.join(":"))).toThrow();
    }
    expect(() => openSecret(name, sealed.replace("v2:old:", "v2:other:"))).toThrow();
    expect(() => openSecret(name, "v1:zz:zz:zz")).toThrow();
  });
  it("requires full entropy production keys and validates keyrings at startup", () => {
    configure();
    vi.stubEnv(name, "long-but-low-entropy-passphrase-used-as-a-key");
    expect(() => validateEncryptionConfiguration(name)).toThrow(/32-byte/);
    vi.stubEnv(name, Buffer.from(oldKey, "hex").toString("base64"));
    expect(() => validateEncryptionConfiguration(name)).not.toThrow();
    vi.stubEnv(`${name}_PREVIOUS_KEYS`, JSON.stringify({ previous: "weak" }));
    expect(() => validateEncryptionConfiguration(name)).toThrow();
    vi.stubEnv(`${name}_PREVIOUS_KEYS`, JSON.stringify({ old: oldKey }));
    expect(() => validateEncryptionConfiguration(name)).toThrow(/IDs must differ/);
  });
});
