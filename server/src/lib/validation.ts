import { publicValidationIssue } from "@docslurp/shared";
import type { Context } from "hono";

import { apiErrorResponse } from "./api-error.js";

export type ValidationIssue = {
  path: string;
  message: string;
  code: string;
  [key: string]: unknown;
};

export type ValidationErrorSource = {
  issues: Array<{
    path: PropertyKey[];
    message: string;
    code: string;
    expected?: unknown;
    minimum?: unknown;
    maximum?: unknown;
    inclusive?: unknown;
    origin?: unknown;
    format?: unknown;
  }>;
};

export function mapValidationIssues(error: ValidationErrorSource): ValidationIssue[] {
  return error.issues.map((issue) => publicValidationIssue(issue) as ValidationIssue);
}

/** Field-level validation failure in the native error envelope; only reviewed paths and constraints reach clients. */
export function validationErrorResponse(c: Context, error: ValidationErrorSource, message: string, status: 400 | 422 = 422): Response {
  return apiErrorResponse(c, status, "invalid_request", message, { issues: mapValidationIssues(error) });
}

/** Default `zValidator` hook: a failed parse is a 400 in the native error envelope. */
export const validationHook = (result: { success: boolean; error?: ValidationErrorSource }, c: Context): Response | undefined => {
  if (result.success) return undefined;
  return validationErrorResponse(c, result.error ?? { issues: [] }, "Invalid request", 400);
};
