// Extension → selective-sync class (design §3.11.1). Pure.

import type { SelectiveClass } from "@shuttle/protocol";
import { extname } from "../path/normalize";

/** Notes are always on; `canvas` and `base` count as notes (design §3.11.1, deviation from Sync). */
export const NOTE_EXTENSIONS: ReadonlySet<string> = new Set(["md", "canvas", "base"]);

export const SELECTIVE_EXTENSIONS: Readonly<Record<Exclude<SelectiveClass, 'other'>, ReadonlySet<string>>> = Object.freeze({
  images: new Set(["bmp", "png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "heic", "heif", "tif", "tiff", "ico"]),
  audio: new Set(["mp3", "wav", "m4a", "3gp", "flac", "ogg", "oga", "opus", "aac"]),
  videos: new Set(["mp4", "webm", "ogv", "mov", "mkv", "m4v", "avi"]),
  pdfs: new Set(["pdf"]),
});

export type FileClass = 'notes' | SelectiveClass;

/** design §3.11.1 table; extension compared case-insensitively. */
export function fileClassOf(path: string): FileClass {
  const ext = extname(path).toLowerCase();
  if (NOTE_EXTENSIONS.has(ext)) return "notes";
  for (const c of ["images", "audio", "videos", "pdfs"] as const) if (SELECTIVE_EXTENSIONS[c].has(ext)) return c;
  return "other";
}

/** All classes on (design §3.11.1 default). */
export const DEFAULT_SELECTIVE: Readonly<Record<SelectiveClass, boolean>> = Object.freeze({
  images: true, audio: true, videos: true, pdfs: true, other: true,
});
