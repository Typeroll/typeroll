// Bounded request body reading for the public Forms endpoint.
//
// Content-Length is only a declaration: a chunked request has none, and
// request.json()/formData() would buffer whatever the client streams. The
// limit is therefore enforced on the bytes actually read.

export class BodyTooLargeError extends Error {
  constructor() { super('Request body too large'); }
}

/** Read the whole body, refusing it as soon as it exceeds maxBytes. */
export async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLargeError();
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

/** Parse an already bounded urlencoded or multipart body; null when malformed. */
export async function parseFormBody(body: Uint8Array<ArrayBuffer>, contentType: string): Promise<FormData | null> {
  return new Response(body, { headers: { 'content-type': contentType } }).formData().catch(() => null);
}

/** Parse an already bounded JSON body; null when malformed. */
export function parseJsonBody(body: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder().decode(body)); } catch { return null; }
}
