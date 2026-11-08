/**
 * The S3 subset Typeroll uses against R2 (and S3-compatible storage), on
 * fetch and `aws4fetch` instead of the AWS SDK: put, get, copy and delete one
 * object, and presigned GET/PUT URLs. The SDK pulled in hundreds of files
 * whose Node and browser variants Workers could not mix, and its XML parser
 * needed a browser global Workers lacks; this has no such variants.
 *
 * The call shapes follow the SDK (`client.send(new PutObjectCommand({...}))`,
 * `getSignedUrl(client, command, { expiresIn })`, errors with `name` and
 * `$metadata.httpStatusCode`), so callers and their tests read the same.
 */
import { AwsClient } from 'aws4fetch';

export interface S3ClientConfig {
  region?: string;
  /** Defaults to Amazon S3 in `region`. */
  endpoint?: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  /** `bucket` in the path instead of the host name. Buckets with dots always use it. */
  forcePathStyle?: boolean;
  /** Accepted for compatibility with SDK configuration objects; this client never adds checksums. */
  requestChecksumCalculation?: string;
  responseChecksumValidation?: string;
  maxAttempts?: number;
}

interface ObjectInput { Bucket: string; Key: string }
export interface PutObjectInput extends ObjectInput {
  Body?: string | Uint8Array | ArrayBuffer | Blob | ReadableStream;
  ContentType?: string;
  CacheControl?: string;
  ContentDisposition?: string;
  ContentLength?: number;
  Metadata?: Record<string, string>;
  IfNoneMatch?: string;
  IfMatch?: string;
}
export interface GetObjectInput extends ObjectInput { ResponseCacheControl?: string; ResponseContentType?: string; ResponseContentDisposition?: string }
export interface CopyObjectInput extends ObjectInput {
  CopySource: string;
  CopySourceIfMatch?: string;
  MetadataDirective?: 'COPY' | 'REPLACE';
  ContentType?: string;
  CacheControl?: string;
  ContentDisposition?: string;
  Metadata?: Record<string, string>;
}
export type DeleteObjectInput = ObjectInput;

export class PutObjectCommand { readonly kind = 'put'; constructor(readonly input: PutObjectInput) {} }
export class GetObjectCommand { readonly kind = 'get'; constructor(readonly input: GetObjectInput) {} }
export class CopyObjectCommand { readonly kind = 'copy'; constructor(readonly input: CopyObjectInput) {} }
export class DeleteObjectCommand { readonly kind = 'delete'; constructor(readonly input: DeleteObjectInput) {} }
type Command = PutObjectCommand | GetObjectCommand | CopyObjectCommand | DeleteObjectCommand;

/** A response body with the SDK's helpers; it is also async-iterable. */
export type ObjectBody = ReadableStream<Uint8Array> & AsyncIterable<Uint8Array> & {
  transformToByteArray(): Promise<Uint8Array>;
  transformToString(encoding?: string): Promise<string>;
};
export interface GetObjectOutput { Body?: ObjectBody; ContentLength?: number; ContentType?: string; ETag?: string; CacheControl?: string; LastModified?: Date }
export interface PutObjectOutput { ETag?: string }
export interface CopyObjectOutput { CopyObjectResult?: { ETag?: string; LastModified?: Date } }
export type DeleteObjectOutput = Record<string, never>;

type Output<C> = C extends GetObjectCommand ? GetObjectOutput : C extends PutObjectCommand ? PutObjectOutput
  : C extends CopyObjectCommand ? CopyObjectOutput : DeleteObjectOutput;

/** An S3 error response: `name` is the S3 error code (`NoSuchKey`, `PreconditionFailed`, …). */
export class S3ServiceError extends Error {
  readonly $metadata: { httpStatusCode: number };
  readonly Code: string;
  constructor(code: string, message: string, status: number) {
    super(message || code);
    this.name = code;
    this.Code = code;
    this.$metadata = { httpStatusCode: status };
  }
}

const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]
  ?.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const escape = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encodeKey = (key: string) => key.split('/').map(escape).join('/');

function withHelpers(stream: ReadableStream<Uint8Array>): ObjectBody {
  const body = stream as ObjectBody;
  body.transformToByteArray = async () => new Uint8Array(await new Response(stream).arrayBuffer());
  body.transformToString = async () => new Response(stream).text();
  if (!(Symbol.asyncIterator in body)) {
    (body as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<Uint8Array> })[Symbol.asyncIterator] = async function* () {
      const reader = stream.getReader();
      try {
        for (;;) { const { done, value } = await reader.read(); if (done) return; yield value; }
      } finally { reader.releaseLock(); }
    };
  }
  return body;
}

interface SendOptions { abortSignal?: AbortSignal }

export class S3Client {
  private readonly aws: AwsClient;
  private readonly endpoint: URL;
  constructor(readonly config: S3ClientConfig) {
    this.aws = new AwsClient({
      accessKeyId: config.credentials.accessKeyId,
      secretAccessKey: config.credentials.secretAccessKey,
      service: 's3',
      region: !config.region || config.region === 'auto' ? 'auto' : config.region,
      retries: 0,
    });
    this.endpoint = new URL(config.endpoint ?? `https://s3.${config.region ?? 'us-east-1'}.amazonaws.com`);
  }

  /** The object's URL, virtual-hosted unless path style is asked for or the bucket name has dots. */
  url(bucket: string, key: string): URL {
    const url = new URL(this.endpoint.toString());
    if (this.config.forcePathStyle || bucket.includes('.')) url.pathname = `/${encodeURIComponent(bucket)}/${encodeKey(key)}`;
    else { url.hostname = `${bucket}.${url.hostname}`; url.pathname = `/${encodeKey(key)}`; }
    return url;
  }

  /** The unsigned request a command describes. */
  request(command: Command): { method: string; url: URL; headers: Record<string, string>; body?: PutObjectInput['Body'] } {
    const { Bucket, Key } = command.input;
    const url = this.url(Bucket, Key);
    const headers: Record<string, string> = {};
    const set = (name: string, value: string | undefined) => { if (value !== undefined) headers[name] = value; };
    if (command instanceof GetObjectCommand) {
      const query: Array<[string, string | undefined]> = [['response-cache-control', command.input.ResponseCacheControl],
        ['response-content-type', command.input.ResponseContentType], ['response-content-disposition', command.input.ResponseContentDisposition]];
      for (const [name, value] of query) if (value !== undefined) url.searchParams.set(name, value);
      return { method: 'GET', url, headers };
    }
    if (command instanceof DeleteObjectCommand) return { method: 'DELETE', url, headers };
    set('content-type', command.input.ContentType);
    set('cache-control', command.input.CacheControl);
    set('content-disposition', command.input.ContentDisposition);
    for (const [name, value] of Object.entries(command.input.Metadata ?? {})) headers[`x-amz-meta-${name.toLowerCase()}`] = value;
    if (command instanceof PutObjectCommand) {
      if (command.input.ContentLength !== undefined) headers['content-length'] = String(command.input.ContentLength);
      set('if-none-match', command.input.IfNoneMatch);
      set('if-match', command.input.IfMatch);
      return { method: 'PUT', url, headers, body: command.input.Body };
    }
    const [sourceBucket, ...sourceKey] = command.input.CopySource.replace(/^\//, '').split('/');
    headers['x-amz-copy-source'] = `/${encodeURIComponent(sourceBucket!)}/${encodeKey(sourceKey.join('/'))}`;
    set('x-amz-metadata-directive', command.input.MetadataDirective);
    set('x-amz-copy-source-if-match', command.input.CopySourceIfMatch);
    return { method: 'PUT', url, headers };
  }

  send(command: GetObjectCommand, options?: SendOptions): Promise<GetObjectOutput>;
  send(command: PutObjectCommand, options?: SendOptions): Promise<PutObjectOutput>;
  send(command: CopyObjectCommand, options?: SendOptions): Promise<CopyObjectOutput>;
  send(command: DeleteObjectCommand, options?: SendOptions): Promise<DeleteObjectOutput>;
  // Callers and test doubles see the SDK's loose shape.
  send(command: Command, options?: SendOptions): Promise<any>;
  async send<C extends Command>(command: C, options: SendOptions = {}): Promise<Output<C>> {
    const { method, url, headers, body } = this.request(command);
    const response = await this.aws.fetch(url.toString(), { method, headers, body: body as BodyInit | undefined, signal: options.abortSignal });
    if (!response.ok) {
      const text = method === 'HEAD' ? '' : await response.text().catch(() => '');
      throw new S3ServiceError(tag(text, 'Code') ?? (response.status === 404 ? 'NotFound' : `Http${response.status}`), tag(text, 'Message') ?? '', response.status);
    }
    const etag = response.headers.get('etag') ?? undefined;
    if (command instanceof GetObjectCommand) {
      const length = response.headers.get('content-length');
      const modified = response.headers.get('last-modified');
      return {
        ...(response.body ? { Body: withHelpers(response.body) } : {}),
        ...(length !== null ? { ContentLength: Number(length) } : {}),
        ContentType: response.headers.get('content-type') ?? undefined,
        CacheControl: response.headers.get('cache-control') ?? undefined,
        ...(modified ? { LastModified: new Date(modified) } : {}),
        ETag: etag,
      } as Output<C>;
    }
    if (command instanceof CopyObjectCommand) {
      // A copy can fail after the 200 status line; the error is then the body.
      const text = await response.text();
      if (/<Error>/.test(text)) throw new S3ServiceError(tag(text, 'Code') ?? 'InternalError', tag(text, 'Message') ?? '', 500);
      const modified = tag(text, 'LastModified');
      return { CopyObjectResult: { ETag: tag(text, 'ETag'), ...(modified ? { LastModified: new Date(modified) } : {}) } } as Output<C>;
    }
    await response.body?.cancel().catch(() => {});
    return (command instanceof PutObjectCommand ? { ETag: etag } : {}) as Output<C>;
  }

  /** Nothing to release: every request is one fetch. Kept so SDK-shaped callers need no change. */
  destroy(): void {}

  /**
   * A presigned URL for a GET or PUT, the URL the AWS SDK presigner makes:
   * only `host` is signed (a PUT's content type and cache control are not
   * bound to it), the payload is unsigned, and `x-id` names the operation.
   */
  async presign(command: GetObjectCommand | PutObjectCommand, expiresIn: number, options: { signableHeaders?: Set<string>; datetime?: string } = {}): Promise<string> {
    const { method, url, headers } = this.request(command);
    const { datetime } = options;
    // Headers the caller binds to the URL (the uploader must send them exactly); host always.
    const signed = Object.fromEntries(Object.entries(headers).filter(([name]) => options.signableHeaders?.has(name)));
    url.searchParams.set('X-Amz-Content-Sha256', 'UNSIGNED-PAYLOAD');
    url.searchParams.set('X-Amz-Expires', String(Math.max(1, Math.min(604_800, Math.floor(expiresIn)))));
    url.searchParams.set('x-id', command instanceof PutObjectCommand ? 'PutObject' : 'GetObject');
    const request = await this.aws.sign(url.toString(), { method, headers: signed, aws: { signQuery: true, allHeaders: true, ...(datetime ? { datetime } : {}) } });
    // The SDK's form of the same signed URL: parameters sorted, RFC 3986 escaping.
    const result = new URL(request.url);
    const query = [...result.searchParams].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, value]) => `${escape(name)}=${escape(value)}`).join('&');
    return `${result.origin}${result.pathname}?${query}`;
  }
}

export function getSignedUrl(client: S3Client, command: GetObjectCommand | PutObjectCommand, options: { expiresIn: number; signableHeaders?: Set<string> }): Promise<string> {
  return client.presign(command, options.expiresIn, { signableHeaders: options.signableHeaders });
}
