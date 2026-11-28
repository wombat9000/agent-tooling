const IMPORT_CLAUSE_SYNTAX_RE = /^(?:type\s+)?(?:[A-Za-z_$][\w$]*(?:\s*,\s*(?:\*\s+as\s+[A-Za-z_$][\w$]*|\{[^}]*\}))?|\*\s+as\s+[A-Za-z_$][\w$]*|\{[^}]*\})$/;
const EXPORT_CLAUSE_SYNTAX_RE = /^(?:type\s+)?(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\})$/;

function scanBlockComment(source: string, start: number): { text: string; nextIndex: number } {
  let i = start + 2;
  let newlines = '';
  while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
    if (source[i] === '\n') newlines += '\n';
    i += 1;
  }
  return { text: `${newlines} `, nextIndex: i < source.length ? i + 2 : i };
}

function scanQuotedString(source: string, start: number): { text: string; nextIndex: number } {
  const quote = source[start];
  let out = quote;
  let i = start + 1;
  while (i < source.length && source[i] !== quote && source[i] !== '\n') {
    if (source[i] === '\\' && i + 1 < source.length) {
      out += source[i] + source[i + 1];
      i += 2;
      continue;
    }
    out += source[i];
    i += 1;
  }
  if (i < source.length) {
    out += source[i];
    i += 1;
  }
  return { text: out, nextIndex: i };
}

function scanTemplateLiteral(source: string, start: number): { text: string; nextIndex: number } {
  let newlines = '';
  let i = start + 1;
  while (i < source.length && source[i] !== '`') {
    if (source[i] === '\\' && i + 1 < source.length) {
      i += 2;
      continue;
    }
    if (source[i] === '\n') newlines += '\n';
    i += 1;
  }
  return { text: `\`\`${newlines}`, nextIndex: i < source.length ? i + 1 : i };
}

function stripCommentsAndTemplates(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = i + 1 < source.length ? source[i + 1] : '';
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (ch === '/' && next === '*') {
      const token = scanBlockComment(source, i);
      out += token.text;
      i = token.nextIndex;
    } else if (ch === '\'' || ch === '"') {
      const token = scanQuotedString(source, i);
      out += token.text;
      i = token.nextIndex;
    } else if (ch === '`') {
      const token = scanTemplateLiteral(source, i);
      out += token.text;
      i = token.nextIndex;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function isRuntimeNamedList(braceBlock: string): boolean {
  const inner = braceBlock.slice(1, -1).trim();
  if (!inner) return false;
  const items = inner.split(',').map((part) => part.trim()).filter(Boolean);
  return items.some((item) => !/^type\s+/.test(item));
}

function isRuntimeClause(rawClause: string, syntaxRe: RegExp): boolean {
  const clause = rawClause.trim();
  if (!syntaxRe.test(clause)) return false;
  if (/^type\s+(?:[*{$A-Za-z_])/.test(clause)) return false;
  if (clause.startsWith('{') && clause.endsWith('}')) {
    return isRuntimeNamedList(clause);
  }
  return true;
}

function collectRuntimeImportSpecifiers(content: string): string[] {
  const clean = stripCommentsAndTemplates(content);
  const specifiers: string[] = [];

  for (const match of clean.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) {
    specifiers.push(match[1]);
  }
  for (const match of clean.matchAll(/^\s*import\s+([^;'"]+?)\s+from\s+['"]([^'"]+)['"]/gm)) {
    if (isRuntimeClause(match[1], IMPORT_CLAUSE_SYNTAX_RE)) {
      specifiers.push(match[2]);
    }
  }
  for (const match of clean.matchAll(/^\s*export\s+([^;'"]+?)\s+from\s+['"]([^'"]+)['"]/gm)) {
    if (isRuntimeClause(match[1], EXPORT_CLAUSE_SYNTAX_RE)) {
      specifiers.push(match[2]);
    }
  }
  return specifiers;
}

function matchesImportPackage(specifier: string, packages: readonly string[]): boolean {
  return packages.some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`));
}

/** Return true if a TS/JS source file contains a runtime (non-type-only) import/re-export from any target package. */
export function hasRuntimeImport(content: string, packages: readonly string[]): boolean {
  if (packages.length === 0) return false;
  return collectRuntimeImportSpecifiers(content).some((spec) => matchesImportPackage(spec, packages));
}

/** Extract unique relative runtime import/re-export specifiers (`./...`, `../...`, `.`, `..`). */
export function extractRelativeRuntimeImports(content: string): string[] {
  const relativeSpecs = collectRuntimeImportSpecifiers(content).filter((spec) => (
    spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../')
  ));
  return [...new Set(relativeSpecs)];
}
