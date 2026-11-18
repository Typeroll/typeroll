import { useEffect, useRef } from 'react';
import { createPreviewRefreshQueue } from '../../lib/editor-preview-refresh';

export function usePreviewRefresh(refresh: () => void) {
  const callback = useRef(refresh); callback.current = refresh;
  const queue = useRef<ReturnType<typeof createPreviewRefreshQueue> | null>(null);
  if (!queue.current) queue.current = createPreviewRefreshQueue(() => callback.current());
  useEffect(() => () => queue.current?.dispose(), []);
  return queue.current;
}
