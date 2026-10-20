/**
 * Reads SQL statements the way the timeline needs them, without a full parser:
 *
 * - normalize: the statement without its values, so executions of the same statement group
 *   together (string literals, numbers and placeholders become `?`, `in (?, ?)` becomes `in (?)`,
 *   `values (?, ?), (?, ?)` becomes `values (?)`, whitespace is collapsed, words are lowercased,
 *   comments are dropped);
 * - columns: which column each placeholder ($1 / ?) is bound to, so a value bound to a password
 *   column can be masked;
 * - masked text: the statement with string literals compared to (or assigned to) sensitive columns
 *   replaced by '[masked]'.
 *
 * Everything works on a token stream that knows string literals, quoted identifiers, comments and
 * dollar-quoted strings, so a `?` or `$1` inside a literal or a comment is never mistaken for a
 * placeholder. Results are cached per statement text: an app sends the same few statements over
 * and over.
 */

import { createHash } from 'crypto';
import { Masker } from './masking.js';
import { LruCache } from './lru.js';

// Statements longer than this are analyzed on their start only: the timeline keeps 4 KB of text,
// and a bulk insert of megabytes must not cost megabytes of tokenizing per execution.
const MAX_ANALYZED = 64 * 1024;
// Text kept per analysis (what the timeline shows), and the longest statement cached: longer ones
// are mostly one-offs (bulk inserts with inline values) that would only push the others out.
const MAX_KEPT = 4096;
const MAX_CACHED = 4096;
const COMPARISON = new Set(['=', '<>', '!=', '<', '>', '<=', '>=']);
const COMPARISON_WORDS = new Set(['like', 'ilike']);
const QUANTIFIERS = new Set(['any', 'all', 'some']);

/**
 * @typedef {Object} SqlAnalysis
 * @property {string} fingerprint - 16 hex chars: sha256 of the normalized text (see normalize())
 * @property {string} maskedText - The text with sensitive literals masked, at most 4096 characters
 * @property {Map<number, string>} columns - Placeholder index (0-based, params[0] is $1 / the first
 *   ?) -> the column it is bound to
 * @property {Set<number>} sensitive - Placeholder indexes bound to sensitive columns
 */

/**
 * SQL analysis with a cache.
 */
export class SqlText {
  /**
   * @param {Object} [options]
   * @param {number} [options.cacheSize=500] - Distinct statements kept analyzed
   */
  constructor({ cacheSize = 500 } = {}) {
    this.cache = new LruCache(cacheSize);
  }

  /**
   * Analyzes a statement, from the cache when it was seen before.
   *
   * @param {string} text - SQL as the app sent it
   * @param {'postgresql'|'mysql'|string} dialect - Decides what "..." means: an identifier in
   *   PostgreSQL, a string in MySQL
   * @returns {SqlAnalysis}
   */
  analyze(text, dialect) {
    if (typeof text !== 'string' || text.length > MAX_CACHED) return SqlText.analyzeUncached(text, dialect);
    const key = `${dialect}\u0000${text}`;
    let analysis = this.cache.get(key);
    if (!analysis) {
      analysis = SqlText.analyzeUncached(text, dialect);
      this.cache.set(key, analysis);
    }
    return analysis;
  }

  /**
   * @param {string} text
   * @param {string} dialect
   * @returns {SqlAnalysis}
   */
  static analyzeUncached(text, dialect) {
    const source = typeof text === 'string' ? text.slice(0, MAX_ANALYZED) : String(text);
    const tokens = tokenize(source, dialectOf(dialect));
    const normalized = normalize(tokens);
    const { columns, sensitive, literalColumns } = bindColumns(tokens);
    return {
      fingerprint: createHash('sha256').update(normalized).digest('hex').slice(0, 16),
      maskedText: maskLiterals(source, tokens, literalColumns).slice(0, MAX_KEPT),
      columns,
      sensitive
    };
  }

  /**
   * Normalizes a statement (see the module comment).
   *
   * @param {string} text
   * @param {string} [dialect='postgresql']
   * @returns {string}
   */
  static normalize(text, dialect = 'postgresql') {
    return normalize(tokenize(String(text).slice(0, MAX_ANALYZED), dialectOf(dialect)));
  }
}

// What the dialect changes in tokenizing: "..." is a string in MySQL and an identifier elsewhere;
// PostgreSQL numbers its placeholders ($1) and uses ? as an operator; others use ? placeholders.
function dialectOf(name) {
  return { mysql: name === 'mysql', pg: name === 'postgresql' };
}

// --- Tokens ---------------------------------------------------------------------------------

// kind: space, comment, string, ident (quoted identifier), number, placeholder, word, punct.
// For placeholders, `index` is the 0-based parameter index.
function tokenize(text, { mysql, pg }) {
  const tokens = [];
  let i = 0;
  let nextQuestion = 0;
  const push = (kind, start, end, extra) => tokens.push({ kind, start, end, text: text.slice(start, end), ...extra });

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    const start = i;

    if (/\s/.test(ch)) {
      while (i < text.length && /\s/.test(text[i])) i++;
      push('space', start, i);
    } else if ((ch === '-' && next === '-') || (mysql && ch === '#')) {
      while (i < text.length && text[i] !== '\n') i++;
      push('comment', start, i);
    } else if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      push('comment', start, i);
    } else if (ch === "'" || ((ch === 'E' || ch === 'e') && next === "'" && pg) || (mysql && ch === '"')) {
      // 'it''s' always; backslash escapes in MySQL and in PostgreSQL E'' strings.
      const quote = ch === '"' ? '"' : "'";
      const backslash = mysql || ch === 'E' || ch === 'e';
      i = ch === 'E' || ch === 'e' ? i + 2 : i + 1;
      while (i < text.length) {
        if (backslash && text[i] === '\\') {
          i += 2;
        } else if (text[i] === quote) {
          if (text[i + 1] === quote) i += 2;
          else {
            i++;
            break;
          }
        } else {
          i++;
        }
      }
      push('string', start, i);
    } else if (ch === '"' || ch === '`') {
      const end = closingQuote(text, i, ch);
      i = end;
      push('ident', start, i, { name: text.slice(start + 1, i - 1).split(ch + ch).join(ch) });
    } else if (ch === '$' && pg && /[0-9]/.test(next || '')) {
      i++;
      while (i < text.length && /[0-9]/.test(text[i])) i++;
      push('placeholder', start, i, { index: Number(text.slice(start + 1, i)) - 1 });
    } else if (ch === '$' && pg && /[A-Za-z_$]/.test(next || '')) {
      // Dollar-quoted string: $$...$$ or $tag$...$tag$.
      const tagEnd = text.indexOf('$', i + 1);
      const tag = tagEnd === -1 ? null : text.slice(i, tagEnd + 1);
      if (tag && /^\$[A-Za-z_]*\$$/.test(tag)) {
        const end = text.indexOf(tag, tagEnd + 1);
        i = end === -1 ? text.length : end + tag.length;
        push('string', start, i);
      } else {
        i++;
        push('punct', start, i);
      }
    } else if (ch === '?' && !pg) {
      // mysql2's ?? (an identifier) consumes a value too.
      i += next === '?' ? 2 : 1;
      push('placeholder', start, i, { index: nextQuestion++ });
    } else if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(next || ''))) {
      if (ch === '0' && (next === 'x' || next === 'X')) {
        i += 2;
        while (i < text.length && /[0-9a-fA-F]/.test(text[i])) i++;
      } else {
        while (i < text.length && /[0-9.]/.test(text[i])) i++;
        if ((text[i] === 'e' || text[i] === 'E') && /[0-9+-]/.test(text[i + 1] || '')) {
          i += 2;
          while (i < text.length && /[0-9]/.test(text[i])) i++;
        }
      }
      push('number', start, i);
    } else if (/[A-Za-z_\u0080-￿]/.test(ch)) {
      while (i < text.length && /[A-Za-z0-9_$\u0080-￿]/.test(text[i])) i++;
      push('word', start, i);
    } else {
      // Two-character operators, then single characters.
      const pair = ch + (next || '');
      i += ['<>', '!=', '<=', '>=', '::', '||'].includes(pair) ? 2 : 1;
      push('punct', start, i);
    }
  }
  return tokens;
}

function closingQuote(text, open, quote) {
  let i = open + 1;
  while (i < text.length) {
    if (text[i] === quote) {
      if (text[i + 1] === quote) i += 2;
      else return i + 1;
    } else {
      i++;
    }
  }
  return text.length;
}

// --- Normalization ----------------------------------------------------------------------------

function normalize(tokens) {
  let out = '';
  let space = false;
  for (const token of tokens) {
    if (token.kind === 'space' || token.kind === 'comment') {
      space = out.length > 0;
      continue;
    }
    if (space) out += ' ';
    space = false;
    if (token.kind === 'string' || token.kind === 'number' || token.kind === 'placeholder') out += '?';
    else if (token.kind === 'ident') out += token.text;
    else out += token.text.toLowerCase();
  }
  return out
    .replace(/\bin \(\s*\?(?:\s*,\s*\?)*\s*\)/g, 'in (?)')
    .replace(/\bin\(\s*\?(?:\s*,\s*\?)*\s*\)/g, 'in(?)')
    .replace(/\bvalues ?\(\s*\?(?:\s*,\s*\?)*\s*\)(?:\s*,\s*\(\s*\?(?:\s*,\s*\?)*\s*\))*/g, 'values (?)');
}

// --- Columns ----------------------------------------------------------------------------------

// The column each placeholder (by index) and each string literal (by token) is bound to. A
// placeholder used twice ($1 in two places) is sensitive when either place is.
function bindColumns(tokens) {
  const significant = tokens.filter((token) => token.kind !== 'space' && token.kind !== 'comment');
  const columns = new Map();
  const sensitive = new Set();
  const literalColumns = new Map();
  const bind = (token, column) => {
    if (!column) return;
    if (token.kind === 'placeholder') {
      if (!columns.has(token.index)) columns.set(token.index, column);
      if (Masker.isSensitiveName(column)) sensitive.add(token.index);
    } else if (token.kind === 'string') {
      if (!literalColumns.has(token) || Masker.isSensitiveName(column)) literalColumns.set(token, column);
    }
  };

  for (let i = 0; i < significant.length; i++) {
    const token = significant[i];
    if (token.kind !== 'placeholder' && token.kind !== 'string') continue;
    bind(token, comparedColumn(significant, i) || reversedColumn(significant, i));
  }
  for (const { token, column } of insertedColumns(significant)) bind(token, column);
  return { columns, sensitive, literalColumns };
}

// `X <op> <column>`: the value first, as in `where $1 = email`.
function reversedColumn(tokens, at) {
  const op = tokens[at + 1];
  if (!op || !COMPARISON.has(op.text)) return null;
  const token = tokens[at + 2];
  if (!token) return null;
  // t.col: the last part.
  let i = at + 2;
  while (tokens[i + 1] && tokens[i + 1].text === '.' && tokens[i + 2] && (tokens[i + 2].kind === 'word' || tokens[i + 2].kind === 'ident')) i += 2;
  const last = tokens[i];
  if (last.kind === 'ident') return last.name;
  if (last.kind === 'word') return last.text;
  return null;
}

// `<column> <op> X`, `<column> [not] like X`, `<column> [not] in (X, ...)`, `<column> = any(X)`.
function comparedColumn(tokens, at) {
  let i = at - 1;
  // Inside parentheses: in (...), any(...).
  if (tokens[i] && (tokens[i].text === '(' || tokens[i].text === ',')) {
    let depth = 0;
    for (; i >= 0; i--) {
      const text = tokens[i].text;
      if (text === ')') depth++;
      else if (text === '(') {
        if (depth === 0) break;
        depth--;
      }
    }
    if (i < 0) return null;
    i--; // before "("
    const word = tokens[i] && tokens[i].kind === 'word' ? tokens[i].text.toLowerCase() : '';
    if (word === 'in') {
      i--;
      if (tokens[i] && tokens[i].kind === 'word' && tokens[i].text.toLowerCase() === 'not') i--;
      return columnBefore(tokens, i);
    }
    if (QUANTIFIERS.has(word)) {
      i--;
      if (!tokens[i] || !COMPARISON.has(tokens[i].text)) return null;
      return columnBefore(tokens, i - 1);
    }
    return null;
  }

  const op = tokens[i];
  if (!op) return null;
  if (COMPARISON.has(op.text)) return columnBefore(tokens, i - 1);
  if (op.kind === 'word' && COMPARISON_WORDS.has(op.text.toLowerCase())) {
    i--;
    if (tokens[i] && tokens[i].kind === 'word' && tokens[i].text.toLowerCase() === 'not') i--;
    return columnBefore(tokens, i);
  }
  return null;
}

// The column expression ending at `i`: `col`, `"col"`, `t.col`, `` `t`.`col` ``, `col::type`.
function columnBefore(tokens, i) {
  // Skip a cast: col::text
  if (tokens[i] && tokens[i].kind === 'word' && tokens[i - 1] && tokens[i - 1].text === '::') i -= 2;
  const token = tokens[i];
  if (!token) return null;
  if (token.kind === 'ident') return token.name;
  if (token.kind === 'word') return token.text;
  return null;
}

// insert into t (c1, c2) values (X, Y), (X, Y): each value is bound to the column at its position.
function insertedColumns(tokens) {
  const bound = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].kind !== 'word' || tokens[i].text.toLowerCase() !== 'insert') continue;
    // The column list: the first "(" after the table name, before "values".
    let j = i + 1;
    while (j < tokens.length && tokens[j].text !== '(' && !(tokens[j].kind === 'word' && /^(values|select|set|default)$/i.test(tokens[j].text))) j++;
    if (!tokens[j] || tokens[j].text !== '(') continue;
    const names = [];
    j++;
    for (; j < tokens.length && tokens[j].text !== ')'; j++) {
      if (tokens[j].kind === 'ident') names.push(tokens[j].name);
      else if (tokens[j].kind === 'word') {
        // t.col: the last part wins.
        if (tokens[j - 1] && tokens[j - 1].text === '.') names[names.length - 1] = tokens[j].text;
        else names.push(tokens[j].text);
      }
    }
    j++;
    if (!tokens[j] || tokens[j].kind !== 'word' || !/^values?$/i.test(tokens[j].text)) continue;
    j++;
    // Tuples: ( a, b ), ( c, d )
    while (tokens[j] && tokens[j].text === '(') {
      let depth = 0;
      let position = 0;
      for (j++; j < tokens.length; j++) {
        const text = tokens[j].text;
        if (text === '(') depth++;
        else if (text === ')') {
          if (depth === 0) break;
          depth--;
        } else if (text === ',' && depth === 0) {
          position++;
        } else if (tokens[j].kind === 'placeholder' || tokens[j].kind === 'string') {
          if (names[position]) bound.push({ token: tokens[j], column: names[position] });
        }
      }
      j++;
      if (tokens[j] && tokens[j].text === ',') j++;
      else break;
    }
  }
  return bound;
}

// --- Masked text ------------------------------------------------------------------------------

// Replaces literals bound to sensitive columns, and literals that look like secrets, with
// '[masked]'. Returns the source itself when nothing needed masking.
function maskLiterals(source, tokens, literalColumns) {
  let out = '';
  let last = 0;
  for (const token of tokens) {
    if (token.kind !== 'string') continue;
    const column = literalColumns.get(token);
    const value = token.text.replace(/^[Ee]?['"]|['"]$/g, '');
    if ((column && Masker.isSensitiveName(column)) || Masker.isSecretString(value)) {
      out += `${source.slice(last, token.start)}'[masked]'`;
      last = token.end;
    }
  }
  return last === 0 ? source : out + source.slice(last);
}
