import { sql } from "../db.js";
import { abortDirectUploadSession, finalizeDirectUploadFile, loadDirectUploadSession, queueAbandonedDirectUploadCleanup, withDirectUploadLock } from "./direct-upload-session.js";
import { WorkspaceIntakeError } from "./workspace-intake.js";
import { confirmDirectUploadWorkspaceIntake } from "./workspace-intake-actions.js";

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;
let stopped = false;

/** Durable schedule plus cross-process session locks make missed webhooks harmless. */
export async function reconcileDirectUploads(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const sessions = await sql<Array<{ id: string; user_id: string; expired: boolean; status: string }>>`
      select id, user_id, status, expires_at < now() as expired from upload_sessions
      where (status in ('pending', 'uploading', 'ingesting') or (status = 'initializing' and expires_at < now())) and next_reconcile_at <= now()
      order by next_reconcile_at limit 25`;
    for (const session of sessions) {
      if (stopped) break;
      let retryCapSeconds = 30;
      try {
        if (session.expired && session.status !== "ingesting") {
          await abortDirectUploadSession(session.id, session.user_id);
          continue;
        }
        const ready = await withDirectUploadLock(session.id, async () => {
          const loaded = await loadDirectUploadSession(session.id, session.user_id);
          if (!loaded || !["pending", "uploading", "ingesting"].includes(loaded.session.status)) return false;
          let ready = true;
          for (const file of loaded.files) {
            if (!await finalizeDirectUploadFile(file)) ready = false;
          }
          return ready;
        });
        if (ready && !stopped) await confirmDirectUploadWorkspaceIntake({ sessionId: session.id, userId: session.user_id });
      } catch (error) {
        retryCapSeconds = 300;
        // Keep retrying recoverable storage/database failures until abandonment.
        // Persist only a generic message: provider errors may contain credentials.
        console.error(`[upload-reconcile] session=${session.id} failed`, error instanceof Error ? error.name : "unknown");
        if (error instanceof WorkspaceIntakeError && error.statusCode !== 409 && error.statusCode < 500) {
          await sql`update upload_sessions set status = 'failed', last_error = 'Upload rejected: stored bytes or intake policy validation failed' where id = ${session.id} and status <> 'confirmed'`;
          await queueAbandonedDirectUploadCleanup(session.id);
        }
        await sql`update upload_sessions set last_error = 'Upload finalization is retrying' where id = ${session.id} and status in ('pending', 'uploading', 'ingesting')`;
      } finally {
        await sql`update upload_sessions set reconcile_attempts = reconcile_attempts + 1,
          next_reconcile_at = now() + least(${retryCapSeconds}, 5 * power(2, least(reconcile_attempts, 6))) * interval '1 second'
          where id = ${session.id} and status in ('pending', 'uploading', 'ingesting')`;
      }
    }
  } finally { running = false; }
}

export function startDirectUploadReconciler(): void {
  if (timer) return;
  stopped = false;
  const tick = () => void reconcileDirectUploads().catch(error => console.error("[upload-reconcile] sweep failed", error instanceof Error ? error.name : "unknown"));
  timer = setInterval(tick, 15_000);
  timer.unref?.();
  tick();
}
export function stopDirectUploadReconciler(): void {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = undefined;
}
