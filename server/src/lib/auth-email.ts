import { isEmailAuthConfigured } from "@docslurp/shared/auth-security";
import { emailOTP } from "better-auth/plugins";

export function createAuthEmailOptions(env: NodeJS.ProcessEnv) {
  const enabled = isEmailAuthConfigured(env);
  return {
    emailAndPassword: { enabled: true, disableSignUp: !enabled, requireEmailVerification: true },
    emailVerification: { sendOnSignUp: enabled, sendOnSignIn: enabled, autoSignInAfterVerification: true },
    plugins: enabled ? [emailOTP({
      overrideDefaultEmailVerification: true,
      sendVerificationOTP: sendAuthEmailCode,
      otpLength: 6,
      expiresIn: 600,
      allowedAttempts: 5,
      storeOTP: "hashed",
      disableSignUp: true,
    })] : [],
  };
}

/** Authentication delivery must succeed; codes are never printed to logs. */
export async function sendAuthEmailCode({ email, otp }: { email: string; otp: string }): Promise<void> {
  if (!isEmailAuthConfigured(process.env)) throw new Error("Email authentication is disabled");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY!.trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM!.trim(),
      to: [email],
      subject: "Your DocSlurp verification code",
      text: `Your DocSlurp code is ${otp}. It expires in 10 minutes. If you did not request this code, ignore this email.`,
    }),
  });
  if (!response.ok) throw new Error("Unable to send verification email");
}
