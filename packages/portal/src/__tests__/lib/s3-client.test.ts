import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client, S3ServiceError, getSignedUrl } from '../../lib/net/s3';

const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
const client = (forcePathStyle = false) => new S3Client({ region: 'auto', endpoint: 'https://acct.r2.cloudflarestorage.com', credentials, forcePathStyle });

// Presigned URLs the AWS SDK (client-s3 + s3-request-presigner 3.1123) made for
// the same input at 2026-11-08T10:00:00Z. Build engines that are already
// deployed consume these URLs, so they must not change shape or signature.
const SDK_PRESIGNED = [
  {"path": false, "cmd": {"Bucket": "media-bucket", "Key": "org/site/a b/å.jpg"}, "put": false, "url": "https://media-bucket.acct.r2.cloudflarestorage.com/org/site/a%20b/%C3%A5.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIDEXAMPLE%2F20261108%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20261108T100000Z&X-Amz-Expires=900&X-Amz-Signature=6154db3d56fe1662e39ae96367f2bae724961f8b0f99aefdba8be20757543969&X-Amz-SignedHeaders=host&x-id=GetObject"},
  {"path": true, "cmd": {"Bucket": "media-bucket", "Key": "x/y.png", "ResponseCacheControl": "private, no-store", "ResponseContentType": "image/png"}, "put": false, "url": "https://acct.r2.cloudflarestorage.com/media-bucket/x/y.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIDEXAMPLE%2F20261108%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20261108T100000Z&X-Amz-Expires=900&X-Amz-Signature=e7f2640d2156f42cb03e6b87b866254df94fdaad319d596ff8f2e4ee360d8c10&X-Amz-SignedHeaders=host&response-cache-control=private%2C%20no-store&response-content-type=image%2Fpng&x-id=GetObject"},
  {"path": false, "cmd": {"Bucket": "media-bucket", "Key": "uploads/1/f.png", "ContentType": "image/png", "CacheControl": "private, no-store"}, "put": true, "url": "https://media-bucket.acct.r2.cloudflarestorage.com/uploads/1/f.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIDEXAMPLE%2F20261108%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20261108T100000Z&X-Amz-Expires=900&X-Amz-Signature=c72dee44f636ae0ebe054349878ac16abfa1ffac35235370c7f4b201b624b7d4&X-Amz-SignedHeaders=host&x-id=PutObject"},
  {"path": false, "cmd": {"Bucket": "orig", "Key": "private/p/prepared/1/abc/hero.webp", "ContentType": "image/webp", "CacheControl": "private, no-store", "IfNoneMatch": "*"}, "put": true, "signable": ["content-type", "cache-control", "if-none-match"], "url": "https://orig.acct.r2.cloudflarestorage.com/private/p/prepared/1/abc/hero.webp?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIDEXAMPLE%2F20261108%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20261108T100000Z&X-Amz-Expires=900&X-Amz-Signature=2b9cb6e96c5b150e475df34748c350e31e716da8730317415e4c68909f91204c&X-Amz-SignedHeaders=cache-control%3Bcontent-type%3Bhost%3Bif-none-match&x-id=PutObject"},
];

function storage(answer: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    return answer(request);
  }));
  return requests;
}
afterEach(() => vi.unstubAllGlobals());

describe('presigned URLs', () => {
  it.each(SDK_PRESIGNED)('match the AWS SDK presigner byte for byte (%#)', async (golden) => {
    const command = golden.put ? new PutObjectCommand(golden.cmd as never) : new GetObjectCommand(golden.cmd as never);
    const url = await client(golden.path).presign(command, 900, { datetime: '20261108T100000Z', ...(golden.signable ? { signableHeaders: new Set(golden.signable as string[]) } : {}) });
    expect(url).toBe(golden.url);
  });

  it('are made through getSignedUrl with the SDK call shape', async () => {
    const url = new URL(await getSignedUrl(client(), new GetObjectCommand({ Bucket: 'b', Key: 'k' }), { expiresIn: 60 }));
    expect(url.host).toBe('b.acct.r2.cloudflarestorage.com');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  });
});

describe('requests', () => {
  it('puts an object with its headers and returns the ETag', async () => {
    const requests = storage(() => new Response(null, { status: 200, headers: { etag: '"abc"' } }));
    const result = await client().send(new PutObjectCommand({ Bucket: 'b', Key: 'a/b c.json', Body: '{}', ContentType: 'application/json', CacheControl: 'no-store', IfNoneMatch: '*', Metadata: { sha256: 'f00' } }));
    expect(result).toEqual({ ETag: '"abc"' });
    const [request] = requests;
    expect(request!.method).toBe('PUT');
    expect(request!.url).toBe('https://b.acct.r2.cloudflarestorage.com/a/b%20c.json');
    expect(Object.fromEntries(['content-type', 'cache-control', 'if-none-match', 'x-amz-meta-sha256'].map(name => [name, request!.headers.get(name)])))
      .toEqual({ 'content-type': 'application/json', 'cache-control': 'no-store', 'if-none-match': '*', 'x-amz-meta-sha256': 'f00' });
    expect(request!.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request/);
    expect(await request!.text()).toBe('{}');
  });

  it('gets an object as a body with the SDK helpers and metadata', async () => {
    storage(() => new Response('hello', { headers: { 'content-type': 'text/plain', 'content-length': '5', etag: '"e"' } }));
    const result = await client(true).send(new GetObjectCommand({ Bucket: 'b', Key: 'k' }));
    expect(result).toMatchObject({ ContentLength: 5, ContentType: 'text/plain', ETag: '"e"' });
    expect(new TextDecoder().decode(await result.Body!.transformToByteArray())).toBe('hello');
  });

  it('streams a body as an async iterable', async () => {
    storage(() => new Response('chunked body'));
    const result = await client().send(new GetObjectCommand({ Bucket: 'b', Key: 'k' }));
    let text = '';
    for await (const chunk of result.Body!) text += new TextDecoder().decode(chunk);
    expect(text).toBe('chunked body');
  });

  it('copies with the source, directive and condition headers and reads the result', async () => {
    const requests = storage(() => new Response('<?xml version="1.0"?><CopyObjectResult><LastModified>2026-11-08T10:00:00.000Z</LastModified><ETag>&quot;c&quot;</ETag></CopyObjectResult>'));
    const result = await client().send(new CopyObjectCommand({ Bucket: 'b', Key: 'final/x.png', CopySource: 'b/uploads/a b.png', MetadataDirective: 'REPLACE', CacheControl: 'public, max-age=31536000, immutable', CopySourceIfMatch: '"e"' }));
    expect(result.CopyObjectResult?.ETag).toBe('"c"');
    expect(requests[0]!.headers.get('x-amz-copy-source')).toBe('/b/uploads/a%20b.png');
    expect(requests[0]!.headers.get('x-amz-metadata-directive')).toBe('REPLACE');
    expect(requests[0]!.headers.get('x-amz-copy-source-if-match')).toBe('"e"');
  });

  it('reports an error inside a 200 copy answer', async () => {
    storage(() => new Response('<Error><Code>InternalError</Code><Message>try again</Message></Error>'));
    await expect(client().send(new CopyObjectCommand({ Bucket: 'b', Key: 'k', CopySource: 'b/s' }))).rejects.toMatchObject({ name: 'InternalError' });
  });

  it('turns an S3 error response into a named error with its status', async () => {
    storage(() => new Response('<?xml version="1.0"?><Error><Code>PreconditionFailed</Code><Message>At least one of the pre-conditions you specified did not hold</Message></Error>', { status: 412 }));
    const error = await client().send(new PutObjectCommand({ Bucket: 'b', Key: 'k', Body: 'x', IfNoneMatch: '*' })).catch(e => e);
    expect(error).toBeInstanceOf(S3ServiceError);
    expect(error).toMatchObject({ name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
  });

  it('names a missing object without an XML body', async () => {
    storage(() => new Response(null, { status: 404 }));
    await expect(client().send(new DeleteObjectCommand({ Bucket: 'b', Key: 'k' }))).rejects.toMatchObject({ name: 'NotFound', $metadata: { httpStatusCode: 404 } });
  });

  it('uses path style for a bucket with dots and Amazon S3 when no endpoint is given', () => {
    expect(client().url('my.bucket', 'k').toString()).toBe('https://acct.r2.cloudflarestorage.com/my.bucket/k');
    expect(new S3Client({ region: 'eu-north-1', credentials }).url('inbound', 'mail/1').toString()).toBe('https://inbound.s3.eu-north-1.amazonaws.com/mail/1');
  });
});
