declare module 'cloudflare:workers' {
  export class DurableObject<Env = unknown> {
    constructor(ctx: unknown, env: Env);
    protected ctx: unknown;
    protected env: Env;
  }
  export class WorkerEntrypoint<Env = unknown> {
    constructor(ctx: unknown, env: Env);
    protected ctx: unknown;
    protected env: Env;
  }
}
