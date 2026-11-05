// Stands in for lib/datastore when a test worker bundles the store modules:
// the real module loads the Node-only Firestore and fixture backends.
export const runReadOnly = <T>(_reader: unknown, work: () => Promise<T>): Promise<T> => work();
export function getStore(): never { throw new Error('No portal store in the test worker'); }
