// Requests the portal makes to its own public origin (the hosted MCP server
// calls the REST API with the caller's key). On Workers a script cannot fetch
// its own hostname: Cloudflare answers 522. The Worker entry registers an
// in-process dispatch through its self service binding instead; Node
// deployments keep the ordinary network fetch.

type Fetch = typeof fetch;

let dispatch: ((request: Request) => Promise<Response>) | null = null;

/** Called once by the Worker entry. */
export function setLoopbackDispatch(handler: ((request: Request) => Promise<Response>) | null): void {
  dispatch = handler;
}

/** A fetch that serves requests for `origin` in process when the runtime can. */
export function portalFetch(origin: string, network: Fetch = globalThis.fetch.bind(globalThis)): Fetch {
  const own = new URL(origin).origin;
  return async (input, init) => {
    const request = new Request(input, init);
    if (!dispatch || new URL(request.url).origin !== own) return network(request);
    return dispatch(request);
  };
}
