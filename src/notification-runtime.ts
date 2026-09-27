/** Single-host worker. Never overlap ticks or close SQLite while a send is pending. */
export class NotificationRuntime {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private started = false;
  private stopped = false;
  private lastStartedAt: string | null = null;
  private lastFinishedAt: string | null = null;
  private lastOutcome: 'idle' | 'ok' | 'failed' = 'idle';
  constructor(private readonly options: {
    enabled: boolean;
    pollIntervalMs: number;
    schedule: () => unknown;
    deliver: () => Promise<unknown>;
    clock?: () => number;
  }) {}
  status() {
    return { enabled: this.options.enabled, running: Boolean(this.running), started: this.started && !this.stopped,
      lastStartedAt: this.lastStartedAt, lastFinishedAt: this.lastFinishedAt, lastOutcome: this.lastOutcome };
  }
  runOnce(): Promise<void> {
    if (this.running) return this.running;
    if (!this.options.enabled || this.stopped) return Promise.resolve();
    this.lastStartedAt = new Date((this.options.clock || Date.now)()).toISOString();
    this.running = Promise.resolve().then(async () => {
      try {
        await this.options.schedule();
        await this.options.deliver();
        this.lastOutcome = 'ok';
      } catch {
        // Provider exceptions and private content must never enter process logs.
        this.lastOutcome = 'failed';
      } finally {
        this.lastFinishedAt = new Date((this.options.clock || Date.now)()).toISOString();
        this.running = undefined;
      }
    });
    return this.running;
  }
  start() {
    if (this.started || this.stopped || !this.options.enabled) return;
    this.started = true;
    const tick = async () => {
      await this.runOnce();
      if (!this.stopped) {
        this.timer = setTimeout(tick, this.options.pollIntervalMs);
        this.timer.unref();
      }
    };
    this.timer = setTimeout(tick, 0);
    this.timer.unref();
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }
}
