export const ALLOWED_UPLOAD_MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/csv',
] as const;

export type AllowedUploadMimeType = (typeof ALLOWED_UPLOAD_MIME_TYPES)[number];

export interface UploadRequest {
  readonly fileName: string;
  readonly mimeType: AllowedUploadMimeType;
  readonly byteSize: number;
}

export function isSupportedUploadMimeType(mimeType: string): mimeType is AllowedUploadMimeType {
  return (ALLOWED_UPLOAD_MIME_TYPES as readonly string[]).includes(mimeType);
}

export function assertSupportedUploadMimeType(mimeType: string): AllowedUploadMimeType {
  const normalized = mimeType.trim().toLowerCase();
  if (!isSupportedUploadMimeType(normalized)) {
    throw new Error(`Unsupported upload media type: ${mimeType}`);
  }
  return normalized;
}
