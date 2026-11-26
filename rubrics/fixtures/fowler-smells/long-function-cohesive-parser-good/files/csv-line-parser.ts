export interface ParsedCsvLine {
  readonly fields: readonly string[];
}

export function parseCsvLine(rawLine: string, delimiter: string = ','): ParsedCsvLine {
  if (delimiter.length !== 1 || delimiter === '"' || delimiter === '\n' || delimiter === '\r') {
    throw new Error(`Unsupported delimiter: ${JSON.stringify(delimiter)}`);
  }
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
  if (line.length === 0) {
    return { fields: [] };
  }

  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  let fieldStarted = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        const next = line[i + 1];
        if (next === '"') {
          current += '"';
          i += 1;
        } else if (next === undefined || next === delimiter) {
          inQuotes = false;
        } else {
          throw new Error(`Unexpected character after closing quote at column ${i + 1}`);
        }
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === delimiter) {
      fields.push(current);
      current = '';
      fieldStarted = false;
    } else if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === '"') {
      throw new Error(`Unexpected quote inside unquoted field at column ${i + 1}`);
    } else {
      current += ch;
      fieldStarted = true;
    }
  }

  if (inQuotes) {
    throw new Error('Unterminated quoted field');
  }
  fields.push(current);
  return { fields };
}
