import { instrumentFetch } from "@docslurp/shared/observability";
import { isEmailAuthConfigured } from "@docslurp/shared/auth-security";
import { emailOTP } from "better-auth/plugins";
import { docslurpMagicLinkPlugin } from "./auth-magic-link.js";
import { APIError } from "better-auth/api";

type DeliveryContext = { context?: { secret?: string } };
type Delivery<T> = (data: T, ctx?: DeliveryContext) => Promise<void>;
/** Wraps a sender with policy (the per-recipient budget refund); identity by default. */
export type DeliveryGuard = <T extends { email: string }>(send: (data: T) => Promise<void>) => Delivery<T>;

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
      expiresIn: 600,
      allowedAttempts: 5,
      storeOTP: "hashed",
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
    ? "Use it to choose a new password. It expires in 10 minutes. If you didn't ask to reset your password, ignore this email; your password hasn't changed."
    : "It expires in 10 minutes. If you didn't ask for it, ignore this email.";
  const lead = reset ? "Your DocSlurp password reset code" : "Your DocSlurp code";
  const text = `${lead}:\n\n${code}\n\n${note}\n`;
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<div style="display:none;max-height:0;overflow:hidden;">${code} expires in 10 minutes.</div>
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
