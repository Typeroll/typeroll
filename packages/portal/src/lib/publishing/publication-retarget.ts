/** Retarget only this site's known origins; preserve external URLs, query strings and fragments. */
export function retargetWebsite<T>(value: T, previousOrigins: string[], nextOrigin: string): T {
  const origins = previousOrigins.filter(Boolean).map(origin => new URL(origin).origin).filter(origin => origin !== nextOrigin);
  const visit = (item: any): any => {
    if (typeof item === 'string') {
      let result = item;
      for (const origin of origins) {
        const escaped = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result = result.replace(new RegExp(`${escaped}(?=[/?#\\s"'<>),\\]\\\\]|$)`, 'g'), () => nextOrigin);
      }
      return result;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, visit(value)]));
    return item;
  };
  return visit(value);
}
