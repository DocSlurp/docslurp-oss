// Shared identity without loading the SDK in exception-only consumers.
export const observabilityRuntimeKey = Symbol.for("docslurp.observability.runtime");
export function hasSharedLogProvider(): boolean {
  const state = (globalThis as typeof globalThis & { [observabilityRuntimeKey]?: { logs?: unknown; shutdown?: unknown } })[observabilityRuntimeKey];
  return Boolean(state?.logs && !state.shutdown);
}
