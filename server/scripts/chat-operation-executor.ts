import "../src/env.js";
import { runChatOperationExecutor } from "../src/services/chat-operation-executor.js";
const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());
await runChatOperationExecutor(shutdown.signal);
