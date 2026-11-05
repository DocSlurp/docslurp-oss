/**
 * An estimator error with a stable `code`: invalid_request, invalid_card, unsupported_rules or crashed, and from the
 * Web Worker client, worker_failed.
 */
export class EstimatorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EstimatorError";
    this.code = code;
  }
}
