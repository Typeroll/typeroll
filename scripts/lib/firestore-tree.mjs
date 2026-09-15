/** Include missing parent documents: deleted pages may still own revisions. */
export async function* walkFirestoreCollection(collection) {
  const references = await collection.listDocuments();
  references.sort((a, b) => a.path.localeCompare(b.path));
  // Bound reads for large installations while retaining deterministic output
  // and visiting descendants even when their parent document was deleted.
  for (let offset = 0; offset < references.length; offset += 8) {
    const batch = await Promise.all(references.slice(offset, offset + 8).map(async reference => {
      const [snapshot, children] = await Promise.all([reference.get(), reference.listCollections()]);
      return { reference, snapshot, children };
    }));
    for (const { reference, snapshot, children } of batch) {
      if (snapshot.exists) yield { path: reference.path, data: snapshot.data() };
      children.sort((a, b) => a.id.localeCompare(b.id));
      for (const child of children) yield* walkFirestoreCollection(child);
    }
  }
}
