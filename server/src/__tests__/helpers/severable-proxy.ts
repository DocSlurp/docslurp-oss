import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface SeverableProxy {
  port: number;
  /** Reset every proxied connection (RST), as a NAT would after a long idle. */
  sever(): Promise<number>;
  stop(): void;
}

export async function startSeverableProxy(targetPort: number, targetHost = "127.0.0.1"): Promise<SeverableProxy> {
  const child: ChildProcess = fork(fileURLToPath(new URL("./sever-proxy.mjs", import.meta.url)));
  const next = <T>(type: string) => new Promise<T>((resolve) => {
    const onMessage = (message: { type: string }) => {
      if (message.type !== type) return;
      child.off("message", onMessage);
      resolve(message as T);
    };
    child.on("message", onMessage);
  });
  const listening = next<{ port: number }>("listening");
  child.send({ type: "listen", target: targetPort, host: targetHost });
  const { port } = await listening;
  return {
    port,
    async sever() {
      const severed = next<{ count: number }>("severed");
      child.send({ type: "sever" });
      return (await severed).count;
    },
    stop: () => { child.kill(); },
  };
}

/** Freeze this process's event loop, like a suspended VM, so socket events queue up unread. */
export function freezeProcess(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
