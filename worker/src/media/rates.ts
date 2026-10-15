import { jsonResponse } from "./http.js";
const verifiedUntil = new Map<string, number>();
/** Public catalog read, never an inference call. Drift fails before paid admission. */
export async function verifyDeepInfraRate(model: string, expected: { perSecondCents?: number; inputTokenCents?: number; outputTokenCents?: number; context?: number }, http: typeof fetch = fetch) {
  const key=JSON.stringify([model,expected]);
  if (http===fetch && (verifiedUntil.get(key) ?? 0)>Date.now()) return;
  const response=await http(`https://api.deepinfra.com/models/${model}`,{signal:AbortSignal.timeout(10000),redirect:"error"});
  const data=await jsonResponse(response) as { pricing?: Record<string,unknown>; max_tokens?: number };
  const price=data.pricing;
  const equal=(v:unknown,n:number) => typeof v==="number" && Number.isFinite(v) && Math.abs(v-n)<=1e-12;
  if (!price || (expected.perSecondCents !== undefined && (price.type!=="input_length" || !equal(price.cents_per_input_sec,expected.perSecondCents))) ||
    (expected.inputTokenCents !== undefined && (price.type!=="tokens" || !equal(price.cents_per_input_token,expected.inputTokenCents) || !equal(price.cents_per_output_token,expected.outputTokenCents!))) ||
    (expected.context !== undefined && data.max_tokens!==expected.context)) throw new Error("DeepInfra media rate/context changed; refresh the verified rate card before dispatch");
  if (http===fetch) verifiedUntil.set(key,Date.now()+300000);
}
