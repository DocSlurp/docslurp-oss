import { describe, expect, it } from "vitest";
import { durableChatTurnOptions } from "./chat-turn-options.js";
import type { RequestActor } from "../lib/request-actor.js";

const session = { type: "session", userId: "user-1", sessionId: "session-1", user: { id: "user-1", email: "", name: "" } } as RequestActor;
const apiKey = { type: "api-key", userId: "user-1" } as unknown as RequestActor;

describe("durableChatTurnOptions", () => {
  it("defaults to web off, suggestions on and no speed boost for the signed-in app", () => {
    expect(durableChatTurnOptions({ q: "Summarize the quarter" }, session)).toEqual({
      speedBoost: false, agent: { web: false, suggestions: true },
    });
  });

  it("carries the composer toggles, retrieval and filters", () => {
    expect(durableChatTurnOptions({
      q: "Where did revenue grow?", speedBoost: true, webTools: true, suggestions: false,
      retrieval: { resultCount: 6 }, filters: { documentIds: ["doc-1"], mimeTypes: ["application/pdf"] },
    }, session)).toEqual({
      speedBoost: true, agent: { web: true, suggestions: false },
      retrieval: { resultCount: 6 }, filters: { documentIds: ["doc-1"], mimeTypes: ["application/pdf"] },
    });
  });

  it("never grants suggestions to a non-session actor", () => {
    expect(durableChatTurnOptions({ suggestions: true }, apiKey).agent.suggestions).toBe(false);
    expect(durableChatTurnOptions({ suggestions: true }, { ...session, sessionId: "" } as RequestActor).agent.suggestions).toBe(false);
  });

  it("refuses malformed or oversized stored options", () => {
    expect(() => durableChatTurnOptions({ webTools: "yes" }, session)).toThrow();
    expect(() => durableChatTurnOptions({ retrieval: { resultCount: 500 } }, session)).toThrow();
    expect(() => durableChatTurnOptions({ retrieval: { unknown: true } }, session)).toThrow();
    expect(() => durableChatTurnOptions({ filters: { documentIds: Array.from({ length: 51 }, (_, i) => `doc-${i}`) } }, session)).toThrow();
    expect(() => durableChatTurnOptions({ filters: { projectId: "other-project" } }, session)).toThrow();
  });
});
