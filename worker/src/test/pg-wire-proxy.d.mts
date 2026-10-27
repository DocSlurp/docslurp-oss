export interface PgWireStats { connections: number; statements: number; flights: number; bySql: Record<string, number> }
export function startPgWireProxy(options: { listenPort?: number; targetHost?: string; targetPort: number; delayMs?: number }):
  Promise<{ port: number; stats(): PgWireStats; reset(): void; close(): Promise<void> }>;
