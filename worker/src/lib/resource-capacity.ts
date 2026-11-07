/** Retry the stage after pressure clears; never mark an unstarted document completed. */
export class ResourceCapacityError extends Error {
  readonly retryable = true;
  constructor() {
    super("Insufficient memory headroom for one document; retry after resource pressure clears");
    this.name = "ResourceCapacityError";
  }
}

