import { expect, it } from "vitest";
import { isExpectedS3Miss } from "../dependency-s3.js";

it("treats only a HeadObject 404 as an expected existence-probe miss", () => {
  expect(isExpectedS3Miss("HeadObject", Object.assign(new Error("UnknownError"), { name: "NotFound" }))).toBe(true);
  expect(isExpectedS3Miss("HeadObject", Object.assign(new Error("UnknownError"), { $metadata: { httpStatusCode: 404 } }))).toBe(true);
  expect(isExpectedS3Miss("HeadObject", Object.assign(new Error("Forbidden"), { $metadata: { httpStatusCode: 403 } }))).toBe(false);
  expect(isExpectedS3Miss("HeadObject", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))).toBe(false);
  expect(isExpectedS3Miss("GetObject", Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } }))).toBe(false);
  expect(isExpectedS3Miss("HeadObject", undefined)).toBe(false);
});
