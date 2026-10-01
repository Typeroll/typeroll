// Convert one text (core/prose) block into separate blocks: headings,
// paragraphs, lists, images and buttons the editor and styles can address.
// Preview first; applying requires the preview's fingerprint so a stale or
// unseen preview cannot be written.

import { createHash } from 'node:crypto';
import type { Block } from '@typeroll/shared';
import { htmlToBlocks, type ConvertResult } from './html-to-blocks';
import { findBlock } from './block-mutations';

export class ProseConvertError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export interface ProseConversion extends Omit<ConvertResult, 'blocks'> {
  /** The blocks that would replace the text block. */
  converted: Block[];
  fingerprint: string;
}

export function previewProseConversion(tree: Block[], blockId: string): ProseConversion {
  const found = findBlock(tree, blockId);
  if (!found) throw new ProseConvertError(`Block "${blockId}" not found`, 404);
  if (found.block.type !== 'core/prose') throw new ProseConvertError('Only text blocks (core/prose) can be converted into blocks', 400);
  const html = String(found.block.data?.html ?? '');
  const result = htmlToBlocks(html);
  const converted = result.blocks.length ? result.blocks : [];
  const notes = [...result.notes];
  if (found.block.style_overrides && converted[0]) {
    converted[0] = { ...converted[0], style_overrides: { ...found.block.style_overrides, ...converted[0].style_overrides } };
    notes.push('The text block\'s spacing, class and anchor move to the first converted block.');
  }
  if (found.block.hidden_on?.length) {
    for (let i = 0; i < converted.length; i++) converted[i] = { ...converted[i], hidden_on: [...found.block.hidden_on] };
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({ blockId, html, unconverted: result.unconverted })).digest('hex');
  return { converted, summary: result.summary, notes, unconverted: result.unconverted, fingerprint };
}

/** Replace the text block with its converted blocks; refuses a stale preview. */
export function applyProseConversion(tree: Block[], blockId: string, accept: string): { blocks: Block[]; conversion: ProseConversion } {
  const conversion = previewProseConversion(tree, blockId);
  if (conversion.fingerprint !== accept) throw new ProseConvertError('The preview is stale. Preview the conversion again and review it.', 409);
  const replace = (list: Block[]): Block[] => list.flatMap(block => {
    if (block.id === blockId) return conversion.converted;
    return [{
      ...block,
      ...(block.children ? { children: replace(block.children) } : {}),
      ...(block.slots ? { slots: block.slots.map(replace) } : {}),
    }];
  });
  return { blocks: replace(tree), conversion };
}
