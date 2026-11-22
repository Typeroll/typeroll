export interface MediaPreparationScope { recipe: string; scope: string; total: number }
export function mediaPreparationScope(publication: any): MediaPreparationScope;
export function freezeMediaPreparation(publication: any, previous: any, previousPrepared?: boolean): MediaPreparationScope & { reused: boolean; cursor: number };
