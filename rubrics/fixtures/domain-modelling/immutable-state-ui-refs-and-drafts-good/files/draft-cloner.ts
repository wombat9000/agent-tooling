export interface InvoiceLine {
  readonly sku: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
}

export interface InvoiceDraft {
  readonly id: string;
  readonly lines: readonly InvoiceLine[];
  readonly subtotalCents: number;
  readonly notes: readonly string[];
}

export function appendLineItem(
  invoice: InvoiceDraft,
  newLine: InvoiceLine,
  note?: string,
): InvoiceDraft {
  const clonedLines = invoice.lines.map((line) => ({ ...line }));
  const clonedNotes = [...invoice.notes];
  const scratch = {
    id: invoice.id,
    lines: clonedLines,
    subtotalCents: invoice.subtotalCents,
    notes: clonedNotes,
  };

  const existing = scratch.lines.find((line) => line.sku === newLine.sku);
  if (existing) {
    existing.quantity += newLine.quantity;
  } else {
    scratch.lines.push({ ...newLine });
  }
  scratch.subtotalCents = scratch.lines.reduce(
    (sum, line) => sum + line.quantity * line.unitPriceCents,
    0,
  );
  if (note?.trim()) {
    scratch.notes.push(note.trim());
  }

  return scratch;
}
