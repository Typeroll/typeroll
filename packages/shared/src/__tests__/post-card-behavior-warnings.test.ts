import { it, expect } from 'vitest';
import { blockTreeWarnings, blockBehaviorWarnings } from '../block-tree-warnings';
it('reports ineffective whole-card links in standalone and bound cards', () => {
  const data = { whole_card_link: true, action_label: 'Read more' };
  for (const type of ['core/post_card', 'core/page_list', 'core/repeater']) {
    const block = { id: 'card', type, data: type === 'core/post_card' ? data : { item_block: 'core/post_card', item_overrides: data } };
    expect(blockTreeWarnings([block])).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ineffective_whole_card_link', block_id: 'card' })]));
  }
  expect(blockBehaviorWarnings({ type:'core/post_card', data:{whole_card_link:true} })).toEqual([]);
  expect(blockBehaviorWarnings({ type:'core/post_card', data:{whole_card_link:false,action_label:'Read'} })).toEqual([]);
});
