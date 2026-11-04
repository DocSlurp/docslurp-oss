import type { chatRouteOptions } from "@mastra/ai-sdk";
import type { PipelineFeatures } from "@docslurp/shared";

export const PROJECT_CHAT_AGENT_ID = "project-agent";
export const projectChatRouteConfig = {
  path: "/chat/:agentId",
} satisfies Pick<chatRouteOptions, "path">;

export function isProjectChatAgent(agentId: string): boolean {
  return agentId === PROJECT_CHAT_AGENT_ID;
}

export interface ExtractionPlan {
  markdownMode: "deterministic" | "vision-assisted";
  htmlMode: "deterministic" | "vision-assisted";
  embed: boolean;
  notes: string[];
}

export interface ExtractionOrchestrator {
  plan(features: PipelineFeatures, mimeType: string): Promise<ExtractionPlan>;
}

class MastraOrchestrator implements ExtractionOrchestrator {
  async plan(features: PipelineFeatures, mimeType: string): Promise<ExtractionPlan> {
    const deterministicPreferred = mimeType.includes("pdf") || mimeType.includes("text") || mimeType.includes("word");

    return {
      markdownMode: deterministicPreferred ? "deterministic" : "vision-assisted",
      htmlMode: deterministicPreferred && features.htmlExtraction ? "deterministic" : "vision-assisted",
      embed: features.embed,
      notes: [
        "Prefer CLI extraction for searchable PDFs and office docs.",
        "Escalate to vision extraction for scans, ligatures, tables, or layout-heavy pages.",
        "Keep this interface narrow so a real Mastra agent graph can be dropped in without changing routes."
      ]
    };
  }
}

export const orchestrator: ExtractionOrchestrator = new MastraOrchestrator();
