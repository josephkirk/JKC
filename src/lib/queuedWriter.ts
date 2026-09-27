export class QueuedDocumentWriter<T> {
  private inFlightPromise: Promise<void> | null = null;
  private pending: { data: T; revision: number } | null = null;
  private lastError: unknown = null;
  private readonly saveFn: (data: T) => Promise<void>;
  private readonly onSaved: (revision: number) => void;
  private readonly onError: (err: unknown) => void;

  constructor(
    saveFn: (data: T) => Promise<void>,
    onSaved: (revision: number) => void,
    onError: (err: unknown) => void
  ) {
    this.saveFn = saveFn;
    this.onSaved = onSaved;
    this.onError = onError;
  }

  public enqueue(data: T, revision: number): Promise<void> {
    this.pending = { data, revision };
    this.lastError = null;
    if (!this.inFlightPromise) {
      this.inFlightPromise = this.drain();
    }
    return this.inFlightPromise;
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending) {
        const current = this.pending;
        this.pending = null;
        try {
          await this.saveFn(current.data);
          this.onSaved(current.revision);
        } catch (err) {
          this.lastError = err;
          this.onError(err);
          break;
        }
      }
    } finally {
      this.inFlightPromise = null;
    }
  }

  public async flush(): Promise<void> {
    if (this.inFlightPromise) {
      await this.inFlightPromise;
    }
    if (this.pending) {
      this.inFlightPromise = this.drain();
      await this.inFlightPromise;
    }
    if (this.lastError) {
      const err = this.lastError;
      this.lastError = null;
      throw err;
    }
  }
}
