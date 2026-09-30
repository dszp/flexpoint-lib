/**
 * Lossless JSON parsing for FlexPoint payloads.
 *
 * FlexPoint ids are int64. Many exceed `Number.MAX_SAFE_INTEGER` (a `payoutId` like
 * `900000000000000123` is 18 digits), and `JSON.parse` silently rounds them — the rounded id then
 * 404s when used in a follow-up request. This parser rewrites every integer under an id-shaped key
 * into a string **before** `JSON.parse` sees it, so ids are always `string` regardless of size.
 *
 * Exported because the same problem applies to anything else that reads FlexPoint JSON: an n8n Code
 * node, a script, or a future webhook receiver.
 */

/** Keys whose integer values are ids: `id`, `customerId`, `invoice_item_id`, `ID`, and plurals (`relatedIds`). */
const ID_KEY = /^(?:ids?|IDs?|.*Ids?|.*_ids?|.*IDs?)$/;

/** Thrown when a non-id field carries an integer JavaScript cannot represent exactly. */
export class FlexPointPrecisionError extends Error {
  constructor(
    public readonly key: string | undefined,
    public readonly literal: string,
  ) {
    super(
      `FlexPoint JSON: ${key ? `field "${key}"` : 'a value'} holds ${literal}, which exceeds ` +
        'Number.MAX_SAFE_INTEGER and would be rounded. Treat it as an id by parsing with a key that ends in "Id".',
    );
    this.name = 'FlexPointPrecisionError';
  }
}

export function isIdKey(key: string | undefined): boolean {
  return key !== undefined && ID_KEY.test(key);
}

/**
 * Parse FlexPoint JSON text. Integers under id-shaped keys (and inside arrays held by such keys)
 * become strings; any other integer outside the safe range throws {@link FlexPointPrecisionError}
 * rather than being rounded. An empty string parses to `undefined`.
 */
export function parseFlexPointJson(text: string): unknown {
  if (text.trim() === '') return undefined;
  return JSON.parse(quoteIdIntegers(text));
}

/**
 * The rewriting pass on its own: a single left-to-right scan that tracks string state and the key
 * each value belongs to. Only integer literals outside strings are touched, so digits inside a
 * string value (a memo reading `"ref:900000000000000123"`) are never altered.
 */
export function quoteIdIntegers(text: string): string {
  let out = '';
  let i = 0;
  let lastKey: string | undefined;
  let prevSignificant = '';
  // For each open container: the key it was opened under (arrays inherit it for their elements).
  const stack: Array<{ kind: '{' | '['; key: string | undefined }> = [];

  while (i < text.length) {
    const ch = text[i]!;

    if (ch === '"') {
      const end = endOfString(text, i);
      const literal = text.slice(i, end);
      out += literal;
      i = end;
      // A string followed by ':' is a key.
      let j = i;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === ':') lastKey = JSON.parse(literal) as string;
      prevSignificant = '"';
      continue;
    }

    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i + 1;
      while (j < text.length && /[0-9eE+.\-]/.test(text[j]!)) j++;
      const literal = text.slice(i, j);
      const top = stack[stack.length - 1];
      const key = prevSignificant === ':' ? lastKey : top?.kind === '[' ? top.key : undefined;
      if (/^-?\d+$/.test(literal)) {
        if (isIdKey(key)) {
          out += `"${literal}"`;
        } else if (!Number.isSafeInteger(Number(literal))) {
          throw new FlexPointPrecisionError(key, literal);
        } else {
          out += literal;
        }
      } else {
        out += literal;
      }
      i = j;
      prevSignificant = '0';
      continue;
    }

    if (ch === '{' || ch === '[') {
      stack.push({ kind: ch, key: prevSignificant === ':' ? lastKey : stack[stack.length - 1]?.key });
    } else if (ch === '}' || ch === ']') {
      stack.pop();
    }
    if (!/\s/.test(ch)) prevSignificant = ch;
    out += ch;
    i++;
  }
  return out;
}

/** Index just past the closing quote of the string starting at `start`. */
function endOfString(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    i++;
  }
  throw new SyntaxError('FlexPoint JSON: unterminated string');
}
