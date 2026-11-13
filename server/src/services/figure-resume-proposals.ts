/*
 * The chat's offer to finish extracting a document's (or a project's) missing figures: prepared by the
 * `proposeFigureResume` tool for the first-party app's card, applied only by the trusted Apply action. Like settings
 * proposals (project-settings-proposals.ts): app-only, bound to the actor, the project, its organization and the chat
 * session, sealed and short-lived. Apply queues resumes under the runner's caps (figure-resume.ts); nothing is charged
 * for the resume itself.
 */
import { FIGURE_RESUME_LIMITS, type FigureResumeProposal } from "@docslurp/shared";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql } from "../db.js";
import type { RequestActor } from "../lib/request-actor.js";
import { isFirstPartyAppActor } from "../lib/first-party-app.js";
import { openSettingsProposal, sealSettingsProposal } from "../lib/settings-proposal-tokens.js";
import { canEditProject, getProjectAccess } from "./organizations.js";
import { appendAuditLog } from "./audit-log.js";
import { countResumableFigureDocuments, requestDocumentFigureResume, requestProjectFigureResumes, resumableWhere, type FigureResumeRequestStatus } from "./figure-resume.js";

const claimsSchema = z.object({
  purpose: z.literal("figure-resume-proposal-v1"), actor: z.string(), userId: z.string(), sessionId: z.string().min(1),
  projectId: z.string(), orgId: z.string(), documentId: z.string().nullable(), expiresAt: z.number(),
  /** Single use: recorded on Apply (figure_resume_proposal_uses); a replay is refused. */
  jti: z.string().regex(/^[A-Za-z0-9-]{16,64}$/),
}).strict();

export class FigureResumeProposalError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 410, readonly category: string, message: string) { super(message); }
}
const fail = (status: 400 | 403 | 404 | 410, category: string, message: string): never => { throw new FigureResumeProposalError(status, category, message); };
const identity = (actor: RequestActor) => actor.type === "session" ? `session:${actor.userId}:${actor.sessionId}` : `key:${actor.userId}:${actor.apiKey.keyId}`;

/** App-only, editor of the project, inside the project's own chat session; the organization comes from the project. */
async function authorize(actor: RequestActor, projectId: string, sessionId: string) {
  if (!isFirstPartyAppActor(actor)) return fail(403, "figure_resume_forbidden", "Finishing figures from chat is available only in the DocSlurp app");
  const access = await getProjectAccess(projectId, actor.userId);
  if (!access || !canEditProject(access, actor.userId)) return fail(403, "figure_resume_forbidden", "Project editing permission is required");
  const [session] = await sql<{ id: string }[]>`select id from chat_sessions where id = ${sessionId} and user_id = ${actor.userId} and project_id = ${projectId}`;
  if (!session) return fail(403, "figure_resume_forbidden", "The proposal must belong to your project conversation");
  return access;
}

/** How many documents an Apply would queue now (one document: 1 or 0). */
async function resumable(scope: { orgId: string; projectId: string }, documentId: string | null): Promise<number> {
  if (!documentId) return await countResumableFigureDocuments(scope);
  // One document: the user's own request, so a budget-blocked document with grants left counts (Apply grants one).
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from document_extraction_levels l join documents d on d.id = l.document_id and d.org_id = l.org_id
    where l.document_id = ${documentId} and ${resumableWhere(scope, "grantable")}`;
  return row?.n ?? 0;
}

export async function proposeFigureResume(args: { actor: RequestActor; projectId: string; sessionId: string; documentId?: string; now?: number }): Promise<FigureResumeProposal> {
  const access = await authorize(args.actor, args.projectId, args.sessionId);
  const documentId = args.documentId ?? null;
  const count = await resumable({ orgId: access.orgId, projectId: args.projectId }, documentId);
  if (count === 0) return fail(400, "figure_resume_unavailable", documentId ? "This document has no figures left to finish" : "No document in this project has figures left to finish");
  const expiresAt = (args.now ?? Date.now()) + 10 * 60_000;
  const token = sealSettingsProposal({ purpose: "figure-resume-proposal-v1", actor: identity(args.actor), userId: args.actor.userId, sessionId: args.sessionId,
    projectId: args.projectId, orgId: access.orgId, documentId, expiresAt, jti: randomUUID() });
  return { token, projectId: args.projectId, documentId, documents: Math.min(count, FIGURE_RESUME_LIMITS.bulkMax), more: count > FIGURE_RESUME_LIMITS.bulkMax,
    expiresAt: new Date(expiresAt).toISOString(), credits: 0 };
}

/** The trusted Apply: re-authorizes everything sealed in the token, then queues (capped). */
export async function applyFigureResumeProposal(args: { actor: RequestActor; projectId: string; token: string; now?: number }): Promise<{
  applied: true; projectId: string; documentId: string | null; status: FigureResumeRequestStatus | "queued" | "off"; queued: number;
}> {
  if (!isFirstPartyAppActor(args.actor)) return fail(403, "figure_resume_forbidden", "Finishing figures from chat is available only in the DocSlurp app");
  const parsed = claimsSchema.safeParse(openSettingsProposal(args.token));
  if (!parsed.success) return fail(403, "figure_resume_invalid", "Invalid proposal");
  const claims = parsed.data;
  if (claims.expiresAt <= (args.now ?? Date.now())) return fail(410, "figure_resume_expired", "This proposal expired; ask again");
  if (claims.actor !== identity(args.actor) || claims.userId !== args.actor.userId || claims.projectId !== args.projectId) {
    return fail(403, "figure_resume_invalid", "This proposal belongs to another actor or project");
  }
  const access = await authorize(args.actor, args.projectId, claims.sessionId);
  if (access.orgId !== claims.orgId) return fail(403, "figure_resume_invalid", "Project organization changed");
  // Single use: the first Apply records the token's id; any replay is refused (and old records age out).
  await sql`delete from figure_resume_proposal_uses where used_at < now() - interval '1 day'`;
  const [fresh] = await sql`insert into figure_resume_proposal_uses (jti, org_id) values (${claims.jti}, ${claims.orgId}) on conflict (jti) do nothing returning 1`;
  if (!fresh) return fail(410, "figure_resume_used", "This proposal was already applied");
  const scope = { orgId: claims.orgId, projectId: claims.projectId };
  let status: FigureResumeRequestStatus | "queued" | "off";
  let queued: number;
  if (claims.documentId) {
    const result = await requestDocumentFigureResume({ ...scope, documentId: claims.documentId });
    status = result.status;
    queued = result.status === "queued" ? 1 : 0;
  } else {
    const result = await requestProjectFigureResumes(scope);
    status = result.status;
    queued = result.queued;
  }
  await appendAuditLog({ orgId: claims.orgId, userId: args.actor.userId, projectId: claims.projectId, ...(claims.documentId ? { documentId: claims.documentId } : {}),
    action: "project.figures.resume_requested", resourceType: claims.documentId ? "document" : "project", resourceId: claims.documentId ?? claims.projectId,
    apiKeyId: null, metadata: { source: "chat-figure-resume-proposal", sessionId: claims.sessionId, status, queued } });
  return { applied: true, projectId: claims.projectId, documentId: claims.documentId, status, queued };
}
