export interface PageControls {
  readonly page: number;
  readonly totalPages: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
}

/** Computes the zero-based record offset for a 1-indexed page number and page size. */
export function computePageOffset(page: number, pageSize: number): number {
  const safePage = Math.max(1, Math.trunc(page));
  const safeSize = Math.max(1, Math.trunc(pageSize));
  return (safePage - 1) * safeSize;
}

/** Clamps a requested 1-indexed page number into the available page range. */
export function clampPageIndex(requestedPage: number, totalItems: number, pageSize: number): number {
  const safeSize = Math.max(1, Math.trunc(pageSize));
  const totalPages = Math.max(1, Math.ceil(Math.max(0, totalItems) / safeSize));
  return Math.min(Math.max(1, Math.trunc(requestedPage)), totalPages);
}

/** Builds pagination boundary flags for list navigation controls. */
export function buildPageControls(requestedPage: number, totalItems: number, pageSize: number): PageControls {
  const safeSize = Math.max(1, Math.trunc(pageSize));
  const totalPages = Math.max(1, Math.ceil(Math.max(0, totalItems) / safeSize));
  const page = clampPageIndex(requestedPage, totalItems, safeSize);
  return { page, totalPages, hasPrevious: page > 1, hasNext: page < totalPages };
}
