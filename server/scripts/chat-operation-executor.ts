import "../src/env.js";
import { runNativeChatWorker } from "../src/agent-runtime/runtime.js";
const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());
await runNativeChatWorker(shutdown.signal);
