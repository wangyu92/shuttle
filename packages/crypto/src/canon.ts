// Canonical JSON (§4.5.2): object keys sorted by UTF-16 code units, no whitespace,
// strings and keys via JSON.stringify, numbers must be safe integers, arrays keep order.
// Unknown fields are included; `undefined`, functions, bigint and non-plain objects are rejected.

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

function canonWith(v: unknown, num: (n: number) => string, depth: number): string {
  if (depth > 64) throw new Error("canon: nesting too deep");
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") return num(v);
  if (Array.isArray(v)) return "[" + v.map((x) => canonWith(x, num, depth + 1)).join(",") + "]";
  if (isPlainObject(v)) {
    // Default Array.prototype.sort compares UTF-16 code units, which is what §4.5.2 asks for.
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonWith(v[k], num, depth + 1))
        .join(",") +
      "}"
    );
  }
  throw new Error(`canon: unsupported value of type ${typeof v}`);
}

/** Strict form used for MACs: throws on any non-safe-integer number. */
export function canon(v: unknown): string {
  return canonWith(
    v,
    (n) => {
      if (!Number.isSafeInteger(n)) throw new Error("canon: non-integer number");
      return String(n);
    },
    0,
  );
}

/** Variant for config-JSON comparison (§3.10.3): non-integers serialized with JSON.stringify. */
export function canonLoose(v: unknown): string {
  return canonWith(
    v,
    (n) => {
      if (!Number.isFinite(n)) throw new Error("canon: non-finite number");
      return Number.isSafeInteger(n) ? String(n) : JSON.stringify(n);
    },
    0,
  );
}

/**
 * Shallow copy of `o` without `field` (e.g. vault-info minus infoMac). The copy has a null prototype
 * so that an own `"__proto__"` key (JSON.parse creates one) is copied as data instead of hitting the
 * Object.prototype setter and silently dropping out of the MAC'd body.
 */
export function without(o: Record<string, unknown>, field: string): Record<string, unknown> {
  const c = Object.create(null) as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== field) c[k] = o[k];
  return c;
}
