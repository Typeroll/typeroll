import { createPage } from './page-create';
import { listContentTypes } from './content-type-service';
// Anthropic client + the AI chat tool loop that powers /api/sites/[siteId]/chat.
//
// The chat lets the user manage the whole site by describing changes in plain
// English. Claude has tools for every meaningful surface — pages, partials
// (header/footer/nav), site settings, content types, media, and
// redirects — and the system prompt teaches it the conventions of the
// platform (HTML mode, CSS variables, status flow, listing patterns).

import './load-env';
import Anthropic from '@anthropic-ai/sdk';
import { vstore } from './version-store';
import { getStore } from './datastore';
import { getBlockUsage, getAllBlockUsage } from './partials-usage';
import { DESIGN_NOTES_STARTER } from './design-notes';
import { PLAYBOOK_STARTER } from './playbook';
import { pageLiveUrl, pagePreviewUrl } from './site-urls';
import { checkRedirectWrite, redirectDocId } from './redirect-write';
import { paths, slugify } from '@typeroll/shared';
import type { Block, BlockType } from '@typeroll/shared';
import { CORE_BLOCK_TYPES } from '@typeroll/shared';
import {
  addBlock as addBlockMutation,
  updateBlock as updateBlockMutation,
  moveBlock as moveBlockMutation,
  removeBlock as removeBlockMutation,
  duplicateBlock as duplicateBlockMutation,
  setBlockResponsiveField,
  findBlock,
  BlockMutationError,
} from './block-mutations';
import {
  normaliseTarget,
  loadContainer,
  writeContainer,
  targetLabel,
  ContainerError,
  type BlockContainerTarget,
} from './block-containers';
import { htmlToBlocks } from './html-to-blocks';
import { snapshotRevision } from './revisions';
import { applyContentWrite } from './content-write';
import {
  commitWorkingCopy,
  discardWorkingCopy,
  overlayWorkingCopy,
  readWorkingCopy,
  WorkingCopyError,
  type WcTarget,
} from './working-copy';
import type {
  Media,
  Page,
  Partial as PartialDoc,
  Redirect,
  Site,
  SiteSettings,
  SiteVersion,
} from '@typeroll/shared';

const MODEL_ID = 'claude-sonnet-4-6';
const MAX_ITERATIONS = 12;

export interface ChatMessageInput {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatAction {
  type: string;
  description: string;
  target?: string;
  preview_url?: string;
}

export interface ChatToolCallLog {
  name: string;
  input_preview: string;
  ok: boolean;
  result_preview: string;
  error?: string;
}

export interface ChatResult {
  reply: string;
  actions: ChatAction[];
  tool_calls: ChatToolCallLog[];
  iterations: number;
}

const TOOL_PREVIEW_MAX = 400;

function previewJson(value: unknown, max = TOOL_PREVIEW_MAX): string {
  let str: string;
  try {
    str = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    str = String(value);
  }
  if (!str) return '';
  return str.length > max ? `${str.slice(0, max)}… (+${str.length - max})` : str;
}

export async function getAnthropic(_orgId: string): Promise<Anthropic | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return new Anthropic({ apiKey: key });
}
