/** Synthetic migration inventory: no customer content or authenticated export. */
export function largeRedirectInventory() {
  return [
    ...Array.from({ length: 837 }, (_, i) => ({
      id: `static-${i}`,
      from_path: i < 702 ? `/wp-content/uploads/2020/01/${'old-image-name-'.repeat(8)}${i}.jpg` : `/old-article-${i}`,
      to_path: `https://media.example.invalid/${'preserved-public-asset-'.repeat(5)}${i}.jpg`,
      status_code: 301,
    })),
    ...Array.from({ length: 99 }, (_, i) => ({
      id: `pattern-${i}`, from_path: `/legacy-${i}/*`, to_path: 'https://archive.example.invalid/:splat', status_code: 301,
    })),
  ];
}
