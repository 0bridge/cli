export const BLOCK_BEGIN = "<!-- 0bridge:begin (managed by 0bridge; edit ~/.0bridge/AGENTS.md instead) -->";
export const BLOCK_END = "<!-- 0bridge:end -->";
const BLOCK = /<!-- 0bridge:begin[^\n]*-->\n?([\s\S]*?)<!-- 0bridge:end -->\n?/;

export function extractUnmanaged(text: string): string {
  return text.replace(BLOCK, "").trim();
}

export function hasBlock(text: string): boolean {
  return BLOCK.test(text);
}

/**
 * Put `canonical` into the managed block of an instructions file, keeping the user's own text.
 * If the file's entire content already equals canonical (first import), it becomes the block.
 * Empty canonical removes the block. `begin`: the block's first line, which says where its text
 * comes from (a repo's blocks come from its own files, not ~/.0bridge/AGENTS.md).
 */
export function applyBlock(current: string, canonical: string, begin = BLOCK_BEGIN): string {
  const body = canonical.trim();
  const block = body ? `${begin}\n${body}\n${BLOCK_END}\n` : "";
  if (BLOCK.test(current)) {
    const out = current.replace(BLOCK, block);
    return block ? out : out.replace(/\n{2,}$/, "\n");
  }
  if (!body) return current;
  if (current.trim() === body || current.trim() === "") return block;
  return current.replace(/\s*$/, "") + "\n\n" + block;
}
