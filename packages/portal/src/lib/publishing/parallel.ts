/** Bound provider pressure while preserving source order and draining started work on failure. */
export async function mapPublicationParts<T, R>(values: T[], work: (value: T, index: number) => Promise<R>, concurrency = 8): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Invalid publication concurrency');
  const output = new Array<R>(values.length);
  let next = 0, failure: unknown, failed = false;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (!failed && next < values.length) {
      const index = next++;
      try { output[index] = await work(values[index], index); }
      catch (error) { failure = error; failed = true; }
    }
  }));
  if (failed) throw failure;
  return output;
}
