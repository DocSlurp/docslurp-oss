type TelegramConfiguration = { token?: string; chatId?: string };
type DeliveryResult =
  | { delivered: true }
  | { delivered: false; reason: "unconfigured" | "rejected" | "unavailable" };

export function createTelegramDelivery({
  configure = () => ({
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID
  }),
  transport = (input, init) => fetch(input, init)
}: {
  configure?: () => TelegramConfiguration;
  transport?: typeof fetch;
} = {}) {
  return async (text: string): Promise<DeliveryResult> => {
    const { token, chatId } = configure();
    if (!token?.trim() || !chatId?.trim()) {
      return { delivered: false, reason: "unconfigured" };
    }

    try {
      const response = await transport(
        `https://api.telegram.org/bot${token.trim()}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId.trim(),
            text: text.slice(0, 4096),
            disable_web_page_preview: true
          }),
          signal: AbortSignal.timeout(8000)
        }
      );
      if (!response.ok) return { delivered: false, reason: "rejected" };
      const body = await response.json();
      return body?.ok === true
        ? { delivered: true }
        : { delivered: false, reason: "rejected" };
    } catch {
      // Fetch errors may contain the token-bearing URL. Never log them.
      return { delivered: false, reason: "unavailable" };
    }
  };
}

const sendTelegramMessage = createTelegramDelivery();

export async function notifySignup({
  kind,
  email,
  name,
  useCase
}: {
  kind: "account" | "waitlist";
  email: string;
  name?: string | null;
  useCase?: string | null;
}): Promise<void> {
  if (process.env.NODE_ENV !== "production") return;

  const lines = [
    `New DocSlurp ${kind} signup`,
    `Environment: ${process.env.NODE_ENV ?? "unknown"}`,
    `Email: ${email.slice(0, 320)}`
  ];
  if (name) lines.push(`Name: ${name.slice(0, 200)}`);
  if (useCase) lines.push(`Use case: ${useCase.slice(0, 1000)}`);

  const result = await sendTelegramMessage(lines.join("\n"));
  if (!result.delivered && result.reason !== "unconfigured") {
    console.warn(`[signup] Telegram notification ${result.reason}`);
  }
}
