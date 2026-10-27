import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { getRequiredEncryptionKey } from "./encryption.js";

const AAD = Buffer.from("docslurp:workspace-settings-proposal:v1");
function key(): Buffer {
  const root = process.env.FILE_TOKEN_SECRET?.trim() ? getRequiredEncryptionKey("FILE_TOKEN_SECRET")
    : process.env.SECRETS_ENCRYPTION_KEY?.trim() ? getRequiredEncryptionKey("SECRETS_ENCRYPTION_KEY")
      : process.env.BETTER_AUTH_SECRET?.trim() ? Buffer.from(process.env.BETTER_AUTH_SECRET.trim()) : null;
  if (!root) throw new Error("Workspace proposals need a configured signing secret");
  return Buffer.from(hkdfSync("sha256", root, "docslurp-workspace-settings", "proposal-approval-v1", 32));
}
export function sealSettingsProposal(claims: Record<string, unknown>): string {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(AAD);
  const body = Buffer.concat([cipher.update(JSON.stringify(claims)), cipher.final()]);
  const token = Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
  if (token.length > 32768) throw new Error("Settings proposal is too large");
  return token;
}
export function openSettingsProposal(token: string): unknown {
  if (!token || token.length > 32768 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    const raw = Buffer.from(token, "base64url");
    if (raw.length <= 28) return null;
    const decipher = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
    decipher.setAAD(AAD); decipher.setAuthTag(raw.subarray(-16));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(12, -16)), decipher.final()]).toString());
  } catch { return null; }
}
