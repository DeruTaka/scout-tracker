// A single-slot background job the client polls instead of blocking on one
// HTTP request. Bulk replay work (scouting a trainer's whole history,
// re-deriving the store) can run for minutes — well past what any reverse
// proxy/host will hold a request open for — so the POST that starts it
// returns immediately and a GET reports progress. Used by /api/ingest,
// /api/scout-user, and /api/refresh identically.
export interface JobState<R> {
  running: boolean;
  done: number;
  total: number;
  currentId: string;
  finishedAt?: number;
  /** A top-level failure (the work itself threw, not a per-item error inside
   *  its own result payload). */
  error?: string;
  result?: R;
}

export class BackgroundJob<R> {
  private state: JobState<R> | null = null;

  get current(): JobState<R> {
    return this.state ?? { running: false, done: 0, total: 0, currentId: '' };
  }

  /** Kick off `run` in the background if nothing is already running. `run`
   *  receives an onProgress callback to report done/total/currentId as it
   *  goes. Returns immediately — never await this for the job's result,
   *  poll `.current` instead. */
  start(total: number, run: (onProgress: (done: number, total: number, id: string) => void) => Promise<R>): { started: boolean; error?: string } {
    if (this.state?.running) return { started: false, error: 'A job of this kind is already running.' };
    this.state = { running: true, done: 0, total, currentId: '' };
    run((done, tot, id) => {
      if (this.state) {
        this.state.done = done;
        this.state.total = tot;
        this.state.currentId = id;
      }
    })
      .then((result) => {
        if (this.state) {
          this.state.running = false;
          this.state.result = result;
          this.state.finishedAt = Date.now();
        }
      })
      .catch((e) => {
        if (this.state) {
          this.state.running = false;
          this.state.error = e instanceof Error ? e.message : String(e);
          this.state.finishedAt = Date.now();
        }
      });
    return { started: true };
  }
}
