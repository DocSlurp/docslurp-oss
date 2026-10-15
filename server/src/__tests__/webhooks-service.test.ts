import { beforeEach, describe, expect, it } from "vitest";

import {
  decryptWebhookSecret,
  encryptWebhookSecret,
  isEncryptedWebhookSecret,
} from "../services/webhooks.js";

describe("webhook secret storage", () => {
  beforeEach(() => {
    process.env.SECRETS_ENCRYPTION_KEY = "test-webhook-secret-encryption-key-at-least-32-bytes";
  });

  it("encrypts stored webhook secrets and decrypts them for delivery signing", () => {
    const plaintext = "whsec_plaintext_should_not_be_stored";
    const encrypted = encryptWebhookSecret(plaintext);

    expect(encrypted).not.toBe(plaintext);
    expect(encrypted).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    expect(isEncryptedWebhookSecret(encrypted)).toBe(true);
    expect(decryptWebhookSecret(encrypted)).toBe(plaintext);
  });

  it("keeps legacy plaintext secrets usable until rotation", () => {
    const legacy = "whsec_legacy_plaintext";

    expect(isEncryptedWebhookSecret(legacy)).toBe(false);
    expect(decryptWebhookSecret(legacy)).toBe(legacy);
  });
});
