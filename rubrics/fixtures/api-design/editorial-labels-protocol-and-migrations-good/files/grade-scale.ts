export const LETTER_GRADES = [
  'A+', 'A', 'A-',
  'B+', 'B', 'B-',
  'C+', 'C', 'C-',
  'D+', 'D', 'D-',
  'E+', 'E', 'E-',
] as const;

export type LetterGrade = (typeof LETTER_GRADES)[number];

export function isLetterGrade(value: string): value is LetterGrade {
  return (LETTER_GRADES as readonly string[]).includes(value);
}

export function parseLetterGrade(raw: string): LetterGrade {
  const normalized = raw.trim().toUpperCase();
  if (!isLetterGrade(normalized)) {
    throw new Error(`Invalid letter grade: ${raw}`);
  }
  return normalized;
}
