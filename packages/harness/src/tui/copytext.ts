/**
 * The one pure selection rule behind Ctrl+X: what counts as "the last reply".
 *
 * Only text an operator would recognize as the brothers' answer may be
 * copied. In order:
 *
 * 1. the newest **committed** decision block (the senior's final decision);
 * 2. else the newest **committed, non-streaming, outgoing senior** envelope
 *    block (a consultation/delegation/proposal/review reply).
 *
 * Tool results, notices, user blocks, compaction summaries, junior-only
 * proposals and streaming drafts are never selected — a partial draft is not
 * a reply, and copying a junior's proposal as if it were the answer would
 * misrepresent the cooperation. `null` means there is nothing honest to copy.
 */
import type { DecisionBlock, EnvelopeBlock, TuiModel } from "./model.ts";

function usableDecision(block: DecisionBlock): boolean {
  return (
    block.committed === true &&
    block.streaming === false &&
    block.interrupted !== true &&
    block.text.trim() !== ""
  );
}

function usableSeniorEnvelope(block: EnvelopeBlock): boolean {
  return (
    block.committed === true &&
    block.streaming === false &&
    block.interrupted !== true &&
    block.role === "senior" &&
    block.direction === "out" &&
    block.text.trim() !== ""
  );
}

/** The newest committed reply text in `model`, or `null` when there is none. */
export function lastReplyText(model: TuiModel): string | null {
  for (let index = model.blocks.length - 1; index >= 0; index -= 1) {
    const block = model.blocks[index];
    if (block !== undefined && block.kind === "decision" && usableDecision(block)) {
      return block.text;
    }
  }
  for (let index = model.blocks.length - 1; index >= 0; index -= 1) {
    const block = model.blocks[index];
    if (
      block !== undefined &&
      block.kind === "envelope" &&
      usableSeniorEnvelope(block)
    ) {
      return block.text;
    }
  }
  return null;
}
