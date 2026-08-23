// Text matching complements genuine SyncTeX: it is the fallback for the WASM
// backend, and refines macro-expanded blocks where SyncTeX can only report the
// invocation (for example every item produced by \maketitle points there).

/** Lowercase, drop everything but words, collapse runs to single spaces. */
export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Strip LaTeX so a source line reduces to its rendered prose. */
export function stripLatex(line: string): string {
  return line
    .replace(/%.*$/, '')            // comments
    // TeX accents must be resolved before commands/markup are removed:
    // Casta\~{n}eda and Castañeda should compare as the same visible word.
    .replace(/\\['"`^~=.]\s*\{?([\p{L}])\}?/gu, '$1')
    // Letter-named accents require braces here so \title is not mistaken for
    // the uncommon \t accent command.
    .replace(/\\[uvHtcdbkr]\s*\{([\p{L}])\}/gu, '$1')
    .replace(/\\[a-zA-Z@]+\*?/g, ' ') // \commands
    .replace(/[{}$&~^_\\]/g, ' ')   // markup punctuation
    .replace(/\[[^\]]*\]/g, ' ')    // optional args
    .trim();
}

/** First `maxWords` normalized words of a string (a distinctive phrase). */
export function phrase(text: string, maxWords = 6): string {
  return normalize(text).split(' ').filter(Boolean).slice(0, maxWords).join(' ');
}

/**
 * Find visible PDF prose in LaTeX source. With a SyncTeX hint, the nearest
 * matching line wins; without one this preserves the old first-match fallback.
 * Three-line windows handle ordinarily wrapped source paragraphs.
 * Returns a zero-based line index.
 */
export function findSourceLine(content: string, text: string, hintLine1?: number): number | null {
  const lines = content.split(/\r?\n/);
  const hint0 = hintLine1 && hintLine1 > 0 ? hintLine1 - 1 : undefined;
  for (const words of [8, 6, 4, 3]) {
    const target = phrase(text, words);
    if (target.split(' ').filter(Boolean).length < Math.min(3, words)) continue;
    const hits: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      // Prefer the exact source line, but permit a short wrapped window. The
      // returned line stays at the first line contributing the match.
      for (let width = 1; width <= 3 && i + width <= lines.length; width++) {
        const src = normalize(stripLatex(lines.slice(i, i + width).join(' ')));
        if (src.length < 4) continue;
        if (src.includes(target) || (target.includes(src) && src.length > 10)) {
          hits.push(i);
          break;
        }
      }
    }
    if (hits.length) {
      return hint0 === undefined
        ? hits[0]
        : hits.reduce((best, line) => Math.abs(line - hint0) < Math.abs(best - hint0) ? line : best);
    }
  }
  return null;
}
