// t(key, params) (design §5.13). English only in v1; ko.json is "later". Unknown keys render as the key
// itself with the parameters, so a missing string is visible instead of blank.

import { EN } from "./en";

export type I18nParams = Readonly<Record<string, string | number | boolean | null | undefined>>;

export function t(key: string, params: I18nParams = {}): string {
  const tpl = EN[key];
  if (tpl === undefined) {
    const extra = Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${String(v)}`);
    return extra.length ? `${key} (${extra.join(", ")})` : key;
  }
  return tpl.replace(/\{([A-Za-z0-9_]+)\}/g, (m, name: string) => {
    const v = params[name];
    return v === undefined || v === null ? m : String(v);
  });
}

export function has(key: string): boolean {
  return EN[key] !== undefined;
}
