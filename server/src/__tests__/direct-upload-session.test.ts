import { describe, expect, it, vi } from "vitest";

const sqlMock = vi.hoisted(() => vi.fn());
vi.mock("../db.js", () => ({ sql: sqlMock }));

import {
  assertDirectUploadSessionReadyForIntake,
  directUploadIntakeItems,
  loadDirectUploadSession,
  toDirectUploadPartCount,
  type LoadedDirectUploadSession,
} from "../services/direct-upload-session.js";
import { WorkspaceIntakeError } from "../services/workspace-intake.js";

function directUploadSessionFixture(
  overrides: {
    session?: Partial<LoadedDirectUploadSession["session"]>;
    files?: LoadedDirectUploadSession["files"];
  } = {},
): LoadedDirectUploadSession {
  return {
    session: {
      id: "session-1",
      user_id: "user-1",
      org_id: "org-1",
      workspace_id: null,
      workspace_name: null,
      template_key: null,
      pipeline: {} as LoadedDirectUploadSession["session"]["pipeline"],
      status: "uploading",
      ...(overrides.session ?? {}),
    },
    files: overrides.files ?? [
      {
        id: "file-1",
        session_id: "session-1",
        filename: "contracts.pdf",
        mime_type: "application/pdf",
        size_bytes: 42,
        source_key: "user-1/raw/contracts.pdf",
        upload_mode: "single",
        upload_id: null,
        part_size: null,
        status: "completed",
        completed_parts: null,
      },
    ],
  };
}

describe("Direct Upload Session Module", () => {
  it("normalizes PostgreSQL bigint sizes before matching and verifying browser files", async () => {
    const fixture = directUploadSessionFixture();
    sqlMock.mockResolvedValueOnce([fixture.session]).mockResolvedValueOnce([
      { ...fixture.files[0], size_bytes: "42", part_size: "8" },
    ]);
    const loaded = await loadDirectUploadSession("session-1", "user-1");
    expect(loaded?.files[0].size_bytes).toBe(42);
    expect(loaded?.files[0].part_size).toBe(8);
  });

  it("computes multipart part counts at the protocol seam", () => {
    expect(toDirectUploadPartCount(1, 8)).toBe(1);
    expect(toDirectUploadPartCount(8, 8)).toBe(1);
    expect(toDirectUploadPartCount(9, 8)).toBe(2);
  });

  it("turns completed session files into a Workspace Intake source", () => {
    expect(
      directUploadIntakeItems(directUploadSessionFixture()),
    ).toEqual([
      {
        filename: "contracts.pdf",
        mimeType: "application/pdf",
        sizeBytes: 42,
        canonicalId: null,
        content: { storedKey: "user-1/raw/contracts.pdf" },
      },
    ]);
  });

  it("keeps direct upload intake readiness rules inside the session seam", () => {
    expect(() =>
      assertDirectUploadSessionReadyForIntake(directUploadSessionFixture()),
    ).not.toThrow();

    expect(() =>
      assertDirectUploadSessionReadyForIntake(
        directUploadSessionFixture({ session: { status: "confirmed" } }),
      ),
    ).toThrow(WorkspaceIntakeError);

    try {
      assertDirectUploadSessionReadyForIntake(
        directUploadSessionFixture({
          files: [
            {
              ...directUploadSessionFixture().files[0],
              status: "pending",
            },
          ],
        }),
      );
      throw new Error("expected readiness assertion to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceIntakeError);
      expect((error as WorkspaceIntakeError).statusCode).toBe(409);
      expect((error as WorkspaceIntakeError).message).toBe(
        "File contracts.pdf is not completed yet",
      );
    }
  });
});
