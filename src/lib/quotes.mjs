/**
 * Layer-A evidence verification, shared by the built-in analysis engine and
 * the MCP server: a quoted evidence string must exist VERBATIM (modulo
 * whitespace and digest rendering artifacts) in the cited thread. This is the
 * deterministic check no model gets a vote on.
 */

export const normWs = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// Quotes are often copied from the corpus digest, where newlines render as
// ' ⏎ ' and long messages end in '…[truncated]' — strip both so a faithful
// multi-line quote still matches the stored message text.
export const normQuote = (s) =>
  normWs(String(s ?? '').replace(/⏎/g, ' ').replace(/…\[truncated\]/g, ' '));

/**
 * Checks one evidence item against a thread object (contract v1).
 * Returns { found: boolean, reason: string }.
 */
export function verifyQuote(thread, quote) {
  if (!thread) return { found: false, reason: 'thread_id does not exist in the corpus' };
  const q = normQuote(quote);
  if (!q) return { found: false, reason: 'empty quote' };
  const found = thread.messages.some((m) => normWs(m.text).includes(q));
  return found
    ? { found: true, reason: 'quote exists verbatim in the thread' }
    : { found: false, reason: 'quote does not appear verbatim in any message of the thread' };
}
