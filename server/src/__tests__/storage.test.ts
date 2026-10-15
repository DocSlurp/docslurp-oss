import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-s3", () => {
  class S3Client {
    send = sendMock;
  }

  class PutObjectCommand {
    input: Record<string, unknown>;

    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }

  class HeadBucketCommand {
    input: Record<string, unknown>;

    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }

  class CreateBucketCommand {
    input: Record<string, unknown>;

    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }

  return {
    S3Client,
    PutObjectCommand,
    HeadBucketCommand,
    CreateBucketCommand
  };
});

const { uploadFile } = await import("../lib/storage.js");

describe("uploadFile", () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it("creates the bucket before uploading when object storage is empty", async () => {
    const missingBucketError = Object.assign(new Error("bucket missing"), {
      name: "NotFound",
      Code: "NoSuchBucket",
      $metadata: { httpStatusCode: 404 }
    });

    sendMock
      .mockRejectedValueOnce(missingBucketError)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await expect(uploadFile("demo/file.txt", Buffer.from("hello"), "text/plain")).resolves.toBe("demo/file.txt");

    expect(sendMock).toHaveBeenCalledTimes(3);
    expect(sendMock.mock.calls.map(([command]) => command.constructor.name)).toEqual([
      "HeadBucketCommand",
      "CreateBucketCommand",
      "PutObjectCommand"
    ]);
  });
});
