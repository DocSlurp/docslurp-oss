import { describe, expect, it, vi } from "vitest";
import { ProjectIntakeError } from "../services/project-intake.js";

const { whenUploadSessionFree } = await import("../routes/uploads.js");
const busy = () => new ProjectIntakeError("Upload session is being finalized; retry shortly", 409, undefined, "upload_session_busy");

describe("confirm right after the last file completed", () => {
  it("waits for the immediate confirm holding the session and returns its result", async () => {
    const run = vi.fn().mockRejectedValueOnce(busy()).mockRejectedValueOnce(busy()).mockResolvedValue({ payload: { run: { id: "s-1" } } });
    await expect(whenUploadSessionFree(run, 5_000)).resolves.toEqual({ payload: { run: { id: "s-1" } } });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("gives up with the busy 409 after the wait, and never retries other errors", async () => {
    await expect(whenUploadSessionFree(vi.fn().mockRejectedValue(busy()), 150)).rejects.toMatchObject({ code: "upload_session_busy" });
    const other = vi.fn().mockRejectedValue(new ProjectIntakeError("Upload session still has incomplete files", 409));
    await expect(whenUploadSessionFree(other, 5_000)).rejects.toThrow("incomplete files");
    expect(other).toHaveBeenCalledOnce();
  });
});
