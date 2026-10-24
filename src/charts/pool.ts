import { type ChildProcess, fork } from 'node:child_process';
import { log } from '../log.js';

const RENDERS_PER_HELPER = 25;
const TIMEOUT_MS = 10_000;
const IDLE_MS = 60_000;

interface Job {
  child: ChildProcess;
  resolve: (png: Buffer) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Draws charts in a separate helper process and recycles it every few charts (and when idle). The image
 * library keeps freed memory around inside whatever process used it; recycling the helper returns all of
 * it, so drawing charts never grows the bot.
 */
export class ChartRenderer {
  private child: ChildProcess | null = null;
  private renders = 0;
  private nextId = 0;
  private idle: NodeJS.Timeout | null = null;
  private readonly jobs = new Map<number, Job>();

  async render(svg: string): Promise<Buffer> {
    const child = this.helper();
    this.renders++;
    const id = this.nextId++;
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.finish(id, new Error('Chart took too long to draw'));
        child.kill();
      }, TIMEOUT_MS);
      this.jobs.set(id, { child, resolve, reject, timer });
      child.send({ id, svg });
    });
  }

  /** Stops the helper (at shutdown). */
  close(): void {
    this.child?.kill();
    this.child = null;
  }

  private helper(): ChildProcess {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.retire(), IDLE_MS);
    this.idle.unref();
    if (this.child && this.renders >= RENDERS_PER_HELPER) this.retire();
    if (this.child) return this.child;

    // Under tsx (development) the helper runs from source; in production from dist/.
    const file = new URL(import.meta.url.endsWith('.ts') ? './renderWorker.ts' : './renderWorker.js', import.meta.url);
    // Same Node flags as the bot (memory limit, the tsx loader in development), minus ones only valid for inline code.
    const execArgv = process.execArgv.filter((a) => !/^--(input-type|eval|print)|^-[ep]$/.test(a));
    const child = fork(file, [], { execArgv, serialization: 'advanced', stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    child.on('message', (msg: { id: number; png?: Uint8Array; error?: string }) => {
      this.finish(msg.id, msg.png ? Buffer.from(msg.png) : new Error(msg.error ?? 'Chart failed'));
      // A retired helper leaves once its last chart is delivered.
      if (child !== this.child && this.pendingOn(child) === 0) child.disconnect();
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      if (code || (signal && signal !== 'SIGTERM')) log.warn(`Chart helper stopped (${code ?? signal})`);
      for (const [id, job] of this.jobs) if (job.child === child) this.finish(id, new Error('Chart helper stopped'));
    });
    child.on('error', (err) => log.warn('Chart helper error', err));
    this.child = child;
    this.renders = 0;
    return child;
  }

  private finish(id: number, result: Buffer | Error): void {
    const job = this.jobs.get(id);
    if (!job) return;
    this.jobs.delete(id);
    clearTimeout(job.timer);
    if (result instanceof Error) job.reject(result);
    else job.resolve(result);
  }

  private pendingOn(child: ChildProcess): number {
    let n = 0;
    for (const job of this.jobs.values()) if (job.child === child) n++;
    return n;
  }

  /** Lets the current helper go: now if it's idle, else after its pending charts. */
  private retire(): void {
    const child = this.child;
    if (!child) return;
    this.child = null;
    if (this.pendingOn(child) === 0 && child.connected) child.disconnect();
  }
}
