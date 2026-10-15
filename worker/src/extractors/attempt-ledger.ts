/** Per-document, per-stage-call admission. Probing availability does not count as execution. */
export class ExtractorAttemptLedger {
  private readonly attempted = new Set<string>();
  private readonly unavailable = new Set<string>();

  canAttempt(id: string): boolean {
    return !this.attempted.has(id) && !this.unavailable.has(id);
  }

  markUnavailable(id: string): void {
    if (!this.attempted.has(id)) this.unavailable.add(id);
  }

  reserve(id: string): void {
    if (!this.canAttempt(id)) throw new Error(`extractor ${id} was already attempted or unavailable`);
    this.attempted.add(id);
  }

  snapshot(): { attempted: string[]; unavailable: string[] } {
    return { attempted: [...this.attempted], unavailable: [...this.unavailable] };
  }
}
