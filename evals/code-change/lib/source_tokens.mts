export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]!);
}

export function span(cls: string, raw: string): string {
  return `<span class="${cls}">${escapeHtml(raw)}</span>`;
}
