// The parts of the Workers runtime API the portal uses. Full
// @cloudflare/workers-types would clash with the DOM types Astro pages need,
// so only these declarations are in scope for type checking.

declare module 'cloudflare:workers' {
  export const env: Record<string, unknown>;
  export class DurableObject<Env = unknown> {
    constructor(ctx: DurableObjectState, env: Env);
    protected ctx: DurableObjectState;
    protected env: Env;
  }
  export class WorkerEntrypoint<Env = unknown> {
    constructor(ctx: ExecutionContext, env: Env);
    protected ctx: ExecutionContext;
    protected env: Env;
  }
}

interface DurableObjectState {
  readonly id: { toString(): string; readonly name?: string };
  readonly storage: unknown;
  waitUntil(promise: Promise<unknown>): void;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
  noRetry(): void;
}

interface ExportedHandler<Env = unknown> {
  fetch?(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
  scheduled?(controller: ScheduledController, env: Env, ctx: ExecutionContext): void | Promise<void>;
}
