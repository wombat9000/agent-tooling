export function slugify(s: string): string { return s.toLowerCase(); }
export function formatCents(c: number): string { return `$${(c / 100).toFixed(2)}`; }
