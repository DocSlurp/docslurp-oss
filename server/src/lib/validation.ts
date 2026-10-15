import type { Context } from "hono";

export type ValidationIssue = {
  path: string;
  message: string;
  code: string;
};

export type ValidationErrorSource = {
  issues: Array<{
    path: PropertyKey[];
    message: string;
    code: string;
  }>;
};

export function mapValidationIssues(error: ValidationErrorSource): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
    code: issue.code
  }));
}

export function validationErrorResponse(c: Context, error: ValidationErrorSource, message: string): Response {
  return c.json(
    {
      error: message,
      issues: mapValidationIssues(error)
    },
    422
  );
}
