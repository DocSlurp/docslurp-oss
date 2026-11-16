import { customerPipelineView } from "@docslurp/shared";
import type { RequestActor } from "./request-actor.js";

/** Platform-admin browser sessions see managed model settings; every other caller (owners, API keys) does not. */
export function seesManagedModels(actor: RequestActor | null | undefined): boolean {
  return actor?.type === "session" && (actor.user as { isAdmin?: boolean } | undefined)?.isAdmin === true;
}

/** A project (or anything with a `pipeline`) as the caller may read it: managed model fields omitted for customers. */
export function publicProjectView<T>(value: T, actor: RequestActor | null | undefined): T {
  if (seesManagedModels(actor) || !value || typeof value !== "object" || !("pipeline" in value)) return value;
  return { ...value, pipeline: customerPipelineView((value as { pipeline: unknown }).pipeline) };
}
