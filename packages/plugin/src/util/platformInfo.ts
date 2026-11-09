// Platform facts the plugin needs, taken from Obsidian's `Platform` once and passed around as data
// so the logic below stays testable (design UX-D2, §3.2).

import type { LocalPlatform } from "@shuttle/protocol";

export interface PlatformInfo {
  isIos: boolean; isAndroid: boolean; isMobile: boolean; isTablet: boolean;
  isMacOS: boolean; isWin: boolean; isLinux: boolean;
}

export function localPlatform(p: PlatformInfo): LocalPlatform {
  if (p.isIos) return "ios";
  if (p.isAndroid) return "android";
  return "desktop";
}

/** macOS, iOS and Windows file systems fold case by default (design §3.2). */
export function caseInsensitive(p: PlatformInfo): boolean {
  return p.isIos || p.isMacOS || p.isWin;
}

/** OS hint for desktop filename rules (engine path/illegal.ts). */
export function osOf(p: PlatformInfo): "windows" | "macos" | "linux" | undefined {
  if (p.isIos || p.isMacOS) return "macos";
  if (p.isWin) return "windows";
  if (p.isLinux || p.isAndroid) return "linux";
  return undefined;
}

/** `client.platform` / `device.platform` string sent to the server. */
export function platformName(p: PlatformInfo): string {
  if (p.isIos) return "ios";
  if (p.isAndroid) return "android";
  if (p.isMacOS) return "macos";
  if (p.isWin) return "windows";
  return "linux";
}

/** design UX-D2 default device names. */
export function defaultDeviceName(p: PlatformInfo): string {
  if (p.isIos) return p.isTablet ? "iPad" : "iPhone";
  if (p.isAndroid) return p.isTablet ? "Android tablet" : "Android phone";
  if (p.isMacOS) return "Mac";
  if (p.isWin) return "Windows PC";
  return "Linux";
}
