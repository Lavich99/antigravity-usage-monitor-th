/**
 * @fileoverview 4 Token (FourSegmentBar).
 * 
 * (Input) (Cached) (Output) (Thinking) Token 
 */

import { h, patchStyleVar } from '../../core/domPatch.js';

/**
 * 4 
 * `--seg-w` CSS 
 *
 * @returns {{
 * el: HTMLElement,
 * update: (metrics: {
 * inputTokens?: number,
 * cacheReadTokens?: number,
 * responseTokens?: number,
 * thinkingTokens?: number
 * }) => void
 * }} 
 */
export function createFourSegmentBar() {
  const segInput = h('div', { className: 'progress-seg seg-input' });
  const segCached = h('div', { className: 'progress-seg seg-cached' });
  const segOutput = h('div', { className: 'progress-seg seg-output' });
  const segThinking = h('div', { className: 'progress-seg seg-thinking' });
  const el = h('div', { className: 'progress-track cons-seg-bar' }, [
    segInput,
    segCached,
    segOutput,
    segThinking,
  ]);

  /**
 * Token 
 */
  function update({ inputTokens = 0, cacheReadTokens = 0, responseTokens = 0, thinkingTokens = 0 }) {
    const total = Math.max(1, inputTokens + cacheReadTokens + responseTokens + thinkingTokens);
    patchStyleVar(segInput, '--seg-w', `${((inputTokens / total) * 100).toFixed(2)}%`);
    patchStyleVar(segCached, '--seg-w', `${((cacheReadTokens / total) * 100).toFixed(2)}%`);
    patchStyleVar(segOutput, '--seg-w', `${((responseTokens / total) * 100).toFixed(2)}%`);
    patchStyleVar(segThinking, '--seg-w', `${((thinkingTokens / total) * 100).toFixed(2)}%`);
  }

  return { el, update };
}
