import { instrumentFetch } from "@docslurp/shared/observability";
import { isEmailAuthConfigured } from "@docslurp/shared/auth-security";
import { emailOTP } from "better-auth/plugins";
import { docslurpMagicLinkPlugin } from "./auth-magic-link.js";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { defineRequestState } from "@better-auth/core/context";
import type { BetterAuthPlugin } from "better-auth";
import type { Pool } from "pg";

type DeliveryContext = { context?: { secret?: string } };
type Delivery<T> = (data: T, ctx?: DeliveryContext) => Promise<void>;
/** Wraps a sender with policy (the per-recipient budget refund); identity by default. */
export type DeliveryGuard = <T extends { email: string }>(send: (data: T) => Promise<void>) => Delivery<T>;

/**
 * Emailed codes (verification, sign-in, password reset, sensitive-account
 * proof) last 12 hours: mail can arrive hours late and we don't control the
 * delay. Guessing stays bounded regardless of lifetime: a code burns after
 * five wrong guesses, and each address gets ten code checks per 15 minutes.
 */
export const EMAIL_CODE_SECONDS = 12 * 60 * 60;

/** The emailed-code row Better Auth keeps for an address and purpose. */
function codeIdentifier(type: string, email: string): string {
  return `${type}-otp-${email.trim().toLowerCase()}`;
}

/** Endpoints that may send an emailed code, and the purpose each one sends. */
function sentCodeType(path: string | undefined, body: { type?: unknown } | undefined): string | null {
  if (path === "/email-otp/send-verification-otp") return typeof body?.type === "string" ? body.type : null;
  if (path === "/email-otp/request-password-reset") return "forget-password";
  if (path === "/send-verification-email" || path === "/sign-in/email" || path === "/sign-up/email") return "email-verification";
  return null;
}

/**
 * A resend sends the same code (resendStrategy "reuse"), but Better Auth's
 * reuse also pushes its expiry 12 hours past the resend. This keeps the
 * expiry from the first send, so a code never outlives 12 hours; a code that
 * expired or burned is replaced, and the new one keeps its own expiry.
 */
export function emailCodeExpiryPlugin(pool: Pick<Pool, "query">): BetterAuthPlugin {
  const issued = defineRequestState<{ identifier: string | null; value: string | null; expiresAt: Date | null }>(() => ({ identifier: null, value: null, expiresAt: null }));
  return {
    id: "docslurp-email-code-expiry",
    hooks: {
      before: [{
        matcher: (ctx) => sentCodeType(ctx.path, ctx.body) !== null,
        handler: createAuthMiddleware(async (ctx) => {
          const type = sentCodeType(ctx.path, ctx.body);
          const email = typeof ctx.body?.email === "string" ? ctx.body.email : "";
          if (!type || !email.trim()) return;
          const identifier = codeIdentifier(type, email);
          const { rows } = await pool.query<{ value: string; expires_at: Date }>(
            `select value, "expiresAt" as expires_at from verification where identifier = $1 and "expiresAt" > now() order by "createdAt" desc limit 1`, [identifier]);
          Object.assign(await issued.get(), { identifier, value: rows[0]?.value ?? null, expiresAt: rows[0]?.expires_at ?? null });
        }),
      }],
      after: [{
        matcher: (ctx) => sentCodeType(ctx.path, ctx.body) !== null,
        handler: createAuthMiddleware(async () => {
          const { identifier, value, expiresAt } = await issued.get();
          if (!identifier || !value || !expiresAt) return;
          // Same stored code (attempt count aside) means it was reused, not rotated.
          await pool.query(
            `update verification set "expiresAt" = least("expiresAt", $3)
              where identifier = $1 and split_part(value, ':', 1) = split_part($2, ':', 1)`, [identifier, value, expiresAt]);
        }),
      }],
    },
  } as BetterAuthPlugin;
}

export function createAuthEmailOptions(env: NodeJS.ProcessEnv, guardDelivery: DeliveryGuard = (send) => (data) => send(data)) {
  const enabled = isEmailAuthConfigured(env);
  return {
    emailAndPassword: {
      enabled: true, disableSignUp: !enabled, requireEmailVerification: true,
      // Recovery assumes the old password may be known to someone else: every
      // session ends, and the trusted-device list is cleared (auth-mfa.ts).
      // A reset never signs in; the next sign-in still needs any second factor.
      revokeSessionsOnPasswordReset: true,
      onPasswordReset: async ({ user }: { user: { id: string } }) => {
        console.info(`[auth] password reset completed user=${user.id}; sessions revoked`);
      },
      // Product policy: an existing account must sign in or recover access,
      // rather than receiving Better Auth's synthetic successful signup ID.
      customSyntheticUser: (): never => {
        throw new APIError("CONFLICT", { code: "EMAIL_ALREADY_REGISTERED", message: "This email is already registered. Sign in or reset your password." });
      },
    },
    emailVerification: { sendOnSignUp: enabled, sendOnSignIn: enabled, autoSignInAfterVerification: true },
    plugins: enabled ? [emailOTP({
      overrideDefaultEmailVerification: true,
      sendVerificationOTP: guardDelivery(sendAuthEmailCode),
      otpLength: 6,
      expiresIn: EMAIL_CODE_SECONDS,
      allowedAttempts: 5,
      // Encrypted with the auth secret (not hashed) so a resend can send the same
      // code: whichever email arrives first, late or not, still works.
      storeOTP: "encrypted",
      resendStrategy: "reuse",
      disableSignUp: true,
    }), docslurpMagicLinkPlugin(guardDelivery(sendAuthMagicLink))] : [],
  };
}

/** Authentication delivery must succeed; codes are never printed to logs. */
export async function sendAuthEmailCode({ email, otp, type }: { email: string; otp: string; type?: string }): Promise<void> {
  if (!isEmailAuthConfigured(process.env)) throw new Error("Email authentication is disabled");
  const response = await instrumentFetch("resend", "email")("https://api.resend.com/emails", {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY!.trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.EMAIL_FROM!.trim(), to: [email], ...renderAuthCodeEmail(otp, type) }),
  });
  if (!response.ok) throw new Error("Unable to send verification email");
}

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "'SFMono-Regular',Menlo,Consolas,'Liberation Mono',monospace";

/**
 * The code leads the subject so it reads straight from the inbox list or a
 * phone notification. A reset code says so: someone who didn't ask for it
 * learns their password is unchanged.
 */
export function renderAuthCodeEmail(otp: string, type?: string): { subject: string; text: string; html: string } {
  const code = otp.replace(/[^0-9A-Za-z]/g, "");
  const reset = type === "forget-password";
  const subject = reset ? `${code} is your DocSlurp password reset code` : `${code} is your DocSlurp code`;
  const note = reset
    ? "Use it to choose a new password. It expires in 12 hours. If you didn't ask to reset your password, ignore this email; your password hasn't changed."
    : "It expires in 12 hours. If you didn't ask for it, ignore this email.";
  const lead = reset ? "Your DocSlurp password reset code" : "Your DocSlurp code";
  const text = `${lead}:\n\n${code}\n\n${note}\n`;
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<div style="display:none;max-height:0;overflow:hidden;">${code} expires in 12 hours.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;"><tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border-radius:16px;border-top:4px solid #14b8a6;">
<tr><td style="padding:28px 32px 4px;font-family:${SANS};font-size:15px;font-weight:700;color:#0f172a;">DocSlurp</td></tr>
<tr><td style="padding:12px 32px 0;font-family:${SANS};font-size:16px;line-height:24px;color:#334155;">${reset ? "Your password reset code:" : "Your code:"}</td></tr>
<tr><td style="padding:12px 32px 16px;"><div style="font-family:${MONO};font-size:40px;line-height:48px;font-weight:700;letter-spacing:10px;color:#0f172a;background:#f1f5f9;border-radius:12px;padding:16px 0 16px 10px;text-align:center;">${code}</div></td></tr>
<tr><td style="padding:0 32px 28px;font-family:${SANS};font-size:14px;line-height:22px;color:#64748b;">${note}</td></tr>
</table></td></tr></table>
</body></html>`;
  return { subject, text, html };
}


/** Native link tokens remain private: delivery errors never include the link. */
export async function sendAuthMagicLink({ email, url }: { email: string; url: string }): Promise<void> {
  if (!isEmailAuthConfigured(process.env)) throw new Error("Email authentication is disabled");
  const escaped = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const response = await instrumentFetch("resend", "email")("https://api.resend.com/emails", {
    method: "POST", signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY!.trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.EMAIL_FROM!.trim(), to: [email], subject: "Your DocSlurp sign-in link",
      text: `Open this link, then choose Continue to sign in:\n\n${url}\n\nThis link expires in 5 minutes and works once. If you did not request it, ignore this email.`,
      html: `<p>Open this link, then choose Continue to sign in:</p><p><a href="${escaped}">Continue to DocSlurp</a></p><p>This link expires in 5 minutes and works once. If you did not request it, ignore this email.</p>`,
    }),
  });
  if (!response.ok) throw new Error("Unable to send sign-in link");
}
