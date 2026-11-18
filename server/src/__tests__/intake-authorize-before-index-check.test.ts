import { describe, expect, it, vi } from "vitest";
import { defaultPipelineFeatures } from "@docslurp/shared";

import { intakeIntoProject, IntakeCredentialRefusedError, type ProjectIntakePorts, type ProjectIntakeRequest } from "../services/project-intake.js";

// A key that lost access to a project gets the credential refusal (403 upstream), never the project's 409
// `reindex_required`, which would tell it whether the project has indexed documents.
const PROJECT = "55555555-5555-4555-8555-555555555555";

function ports() {
  const hasIndexStakes = vi.fn(async () => true);
  const put = vi.fn(async () => undefined);
  const records = {
    findProject: vi.fn(async () => ({ id: PROJECT, orgId: "o", name: "Results", slug: "results", pipeline: defaultPipelineFeatures, templateKey: null })),
    defaultProject: vi.fn(),
    hasIndexStakes,
    createProject: vi.fn(),
    createRun: vi.fn(),
  };
  return { hasIndexStakes, put, ports: { storage: { put, delete: vi.fn(async () => undefined) }, records } as unknown as ProjectIntakePorts };
}

function request(authorizeExternalWork: ProjectIntakeRequest["authorizeExternalWork"]): ProjectIntakeRequest {
  return {
    kind: "bulk-upload", userId: "u", orgId: "o", project: PROJECT,
    // An override of an index-identity setting: locked once the project has indexed documents.
    pipeline: { embedding: { profile: "fastest-local" } } as never,
    items: [{ filename: "results.txt", mimeType: "text/plain", content: { bytes: Buffer.from("Results beat expectations.") } }],
    authorizeExternalWork,
  } as ProjectIntakeRequest;
}

describe("the resolved target is authorized before the index-identity check", () => {
  it("refuses a key that lost access with the credential refusal, without looking at the project's index", async () => {
    const { ports: p, hasIndexStakes, put } = ports();
    await expect(intakeIntoProject(request(async () => { throw new IntakeCredentialRefusedError(); }), p)).rejects.toBeInstanceOf(IntakeCredentialRefusedError);
    expect(hasIndexStakes).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("an authorized caller still gets reindex_required for a locked setting", async () => {
    const { ports: p, put } = ports();
    await expect(intakeIntoProject(request(async () => {}), p)).rejects.toMatchObject({ statusCode: 409, code: "reindex_required" });
    expect(put).not.toHaveBeenCalled();
  });
});
