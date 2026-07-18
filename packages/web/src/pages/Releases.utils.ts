// Pure helpers for the symbol upload zone, split out from Releases.tsx for unit testing
// without needing DOM drag events.

import { MAX_SYMBOL_UPLOAD_BYTES } from '../api.js';

export const formatMb = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)}MB`;

/** Returns a friendly error message if the file exceeds the server's upload cap, else null. */
export const oversizeError = (fileSize: number): string | null =>
  fileSize > MAX_SYMBOL_UPLOAD_BYTES
    ? `File is ${formatMb(fileSize)} — the server limit is ${formatMb(MAX_SYMBOL_UPLOAD_BYTES)}.`
    : null;
