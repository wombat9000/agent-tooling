/** Build-time syntax highlighting for TypeScript and TSX source in reports. */
import { escapeHtml, span } from './source_tokens.mts';

const KEYWORDS = new Set(
  ('abstract accessor as async await break case catch class const constructor continue declare default delete do else '
   + 'enum export extends finally for from function get if implements import in infer instanceof interface keyof let '
   + 'namespace new of override private protected public readonly return satisfies set static super switch this throw '
   + 'try type typeof using var void while with yield').split(' '),
);
const TYPES = new Set('any bigint boolean never number object string symbol unknown'.split(' '));
const LITERALS = new Set(['true', 'false', 'null', 'undefined']);
const EXPRESSION_KEYWORDS = new Set(
  'await case delete in instanceof new of return throw typeof void yield'.split(' '),
);

const IDENTIFIER = /[\p{ID_Start}_$][\p{ID_Continue}$\u200C\u200D]*/uy;
const NUMBER = /(?:0[xX][\da-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+n?|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d[\d_]*)?n?|\.\d[\d_]*(?:[eE][+-]?\d[\d_]*)?)/y;
const STRING = /"(?:\\[\s\S]|[^"\\\r\n])*"?|'(?:\\[\s\S]|[^'\\\r\n])*'?/y;
const REGEX = /\/(?:\\[^\r\n]|\[(?:\\[^\r\n]|[^\]\\\r\n])*\]|[^/\\[\r\n])+\/[a-z]*/y;
const JSX_TAG = /<\/?(?:[\p{ID_Start}_$][\p{ID_Continue}.$:-]*|(?=>))/uy;
const JSX_ATTRIBUTE = /[\p{ID_Start}_$][\p{ID_Continue}.$:-]*/uy;
const JSX_STRING = /"[^"]*"?|'[^']*'?/y;
const JSX_TEXT = /[^<{]+/y;
const TEMPLATE_TEXT = /(?:\\[\s\S]|[^\\`$]|\$(?!\{))+/y;
const GENERIC_ARROW_PREFIX = /\s*(?:,|extends\b|=)/y;
const LINE_COMMENT = /\/\/[^\r\n]*/y;
const WHITESPACE = /\s+/y;
const CALL = /\s*\(/y;

type Script = { kind: 'script'; braces: number; expectsExpression: boolean };
type Jsx = { kind: 'jsx'; depth: number; tag: 'opening' | 'closing' | null; typeArgs: number };
type Context = Script | Jsx | { kind: 'template' };

function matchAt(pattern: RegExp, source: string, index: number): string | undefined {
  pattern.lastIndex = index;
  return pattern.exec(source)?.[0];
}

function wordClass(word: string, source: string, end: number): string | undefined {
  if (KEYWORDS.has(word)) return 'tok-kw';
  if (LITERALS.has(word)) return 'tok-num';
  if (/^[A-Z][A-Z0-9_]+$/.test(word)) return 'tok-const';
  if (TYPES.has(word) || /^[A-Z]/.test(word)) return 'tok-ty';
  if (matchAt(CALL, source, end) !== undefined) return 'tok-fn';
}

/** Return one escaped HTML string per input line, including spans for JSX and embedded expressions. */
export function highlightTypeScriptLines(lines: string[], jsx: boolean): string[] {
  const source = lines.join('\n');
  const rendered = [''];
  const contexts: Context[] = [{ kind: 'script', braces: 0, expectsExpression: true }];
  let index = 0;

  function emit(raw: string, tokenClass?: string) {
    const parts = raw.split('\n');
    parts.forEach((part, line) => {
      if (line > 0) rendered.push('');
      if (part) rendered[rendered.length - 1] += tokenClass ? span(tokenClass, part) : escapeHtml(part);
    });
    index += raw.length;
  }

  function openExpression(opener: string) {
    emit(opener, 'tok-kw');
    contexts.push({ kind: 'script', braces: 1, expectsExpression: true });
  }

  function openTag(context: Jsx, tag: string) {
    context.tag = tag.startsWith('</') ? 'closing' : 'opening';
    if (context.tag === 'opening') context.depth += 1;
    emit(tag, 'tok-ty');
  }

  while (index < source.length) {
    const context = contexts[contexts.length - 1];
    const ch = source[index];

    if (context.kind === 'template') {
      if (ch === '`') {
        emit(ch, 'tok-str');
        contexts.pop();
      } else if (source.startsWith('${', index)) {
        openExpression('${');
      } else {
        emit(matchAt(TEMPLATE_TEXT, source, index) ?? ch, 'tok-str');
      }
      continue;
    }

    if (context.kind === 'jsx') {
      if (ch === '{') {
        openExpression(ch);
      } else if (context.tag === null) {
        const tag = matchAt(JSX_TAG, source, index);
        if (tag) openTag(context, tag);
        else emit(matchAt(JSX_TEXT, source, index) ?? ch);
      } else if (ch === '<' || (ch === '>' && context.typeArgs > 0)) {
        context.typeArgs += ch === '<' ? 1 : -1;
        emit(ch);
      } else if (ch === '>' || source.startsWith('/>', index)) {
        const selfClosing = ch === '/';
        emit(selfClosing ? '/>' : '>', 'tok-ty');
        if (context.tag === 'closing' || selfClosing) context.depth -= 1;
        context.tag = null;
        if (context.depth === 0) contexts.pop();
      } else {
        const value = matchAt(JSX_STRING, source, index);
        const name = matchAt(JSX_ATTRIBUTE, source, index);
        if (value) emit(value, 'tok-str');
        else if (name) emit(name, context.typeArgs > 0 ? 'tok-ty' : 'tok-ann');
        else emit(ch);
      }
      continue;
    }

    const whitespace = matchAt(WHITESPACE, source, index);
    const lineComment = matchAt(LINE_COMMENT, source, index);
    if (whitespace) {
      emit(whitespace);
      continue;
    }
    if (lineComment || source.startsWith('/*', index)) {
      const close = lineComment ? -1 : source.indexOf('*/', index + 2);
      emit(lineComment ?? source.slice(index, close < 0 ? source.length : close + 2), 'tok-cm');
      continue;
    }

    if (context.braces > 0 && ch === '}') {
      context.braces -= 1;
      if (context.braces === 0) {
        emit(ch, 'tok-kw');
        contexts.pop();
        continue;
      }
    } else if (context.braces > 0 && ch === '{') {
      context.braces += 1;
    }

    const tag = jsx && context.expectsExpression ? matchAt(JSX_TAG, source, index) : undefined;
    if (tag && !tag.startsWith('</') && !matchAt(GENERIC_ARROW_PREFIX, source, index + tag.length)) {
      const element: Jsx = { kind: 'jsx', depth: 0, tag: null, typeArgs: 0 };
      context.expectsExpression = false;
      contexts.push(element);
      openTag(element, tag);
      continue;
    }

    const string = matchAt(STRING, source, index)
      ?? (context.expectsExpression ? matchAt(REGEX, source, index) : undefined);
    const number = matchAt(NUMBER, source, index);
    const word = matchAt(IDENTIFIER, source, index);
    if (ch === '`') {
      emit(ch, 'tok-str');
      contexts.push({ kind: 'template' });
      context.expectsExpression = false;
    } else if (string) {
      emit(string, 'tok-str');
      context.expectsExpression = false;
    } else if (number) {
      emit(number, 'tok-num');
      context.expectsExpression = false;
    } else if (word) {
      emit(word, wordClass(word, source, index + word.length));
      context.expectsExpression = EXPRESSION_KEYWORDS.has(word);
    } else {
      emit(ch);
      context.expectsExpression = '=>([{:;,!?&|+-*%~^'.includes(ch);
    }
  }

  return lines.length ? rendered.map((line) => line || ' ') : [];
}
