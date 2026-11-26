/**
 * An estimator error with a stable `code`: invalid_request, crashed (a panic) or out_of_memory (the file needed more
 * than the module's memory); from the Web Worker client, worker_failed; from
 * `requestQuote`, quote_failed.
 */
export class EstimatorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EstimatorError";
    this.code = code;
  }
}
