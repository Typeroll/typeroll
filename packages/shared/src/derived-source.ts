/** Query publication output without storing editable copies of derived facts. */
export interface DerivedQuery {
  source: string;
  filter_field?: string;
  filter_value?: string;
  limit?: number;
}
export function queryDerivedSource(sources: Record<string, Array<Record<string, unknown>>>, query: DerivedQuery): Array<Record<string, unknown>> {
  const source = Object.hasOwn(sources, query.source) ? sources[query.source] : undefined;
  let rows = Array.isArray(source) ? source.filter(row => row !== null && typeof row === 'object' && !Array.isArray(row)) : [];
  if (query.filter_field && query.filter_value !== undefined) {
    const field = query.filter_field;
    const value = query.filter_value;
    rows = rows.filter(row => Object.hasOwn(row, field) &&
      (Array.isArray(row[field]) ? row[field].some(item => String(item) === value) : String(row[field]) === value));
  }
  if (typeof query.limit === 'number' && query.limit > 0) rows = rows.slice(0, Math.floor(query.limit));
  return rows;
}
