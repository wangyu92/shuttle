// The Add device QR code (util/qr.ts) decodes back to the enrollment link, with a quiet zone.
import { describe, expect, it } from "vitest";
import jsQR from "jsqr";
import { QUIET_ZONE, qrMatrix } from "../src/util/qr";

function rgba(m: boolean[][], scale: number): { data: Uint8ClampedArray; size: number } {
  const size = (m.length + QUIET_ZONE * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let r = 0; r < m.length; r++) {
    for (let c = 0; c < m.length; c++) {
      if (!m[r]![c]) continue;
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const i = (((r + QUIET_ZONE) * scale + y) * size + (c + QUIET_ZONE) * scale + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return { data, size };
}

describe("qr", () => {
  const link = "obsidian://shuttle-enroll?server=https%3A%2F%2Fsync.example.com%3A6984&code=SXE-7K3Q-M9WD-2HPV-X4TA-Q8RZ";

  it("decodes back to the link", () => {
    const m = qrMatrix(link);
    expect(m.length).toBeGreaterThanOrEqual(21);
    const { data, size } = rgba(m, 4);
    expect(jsQR(data, size, size)?.data).toBe(link);
  });

  it("has finder patterns in three corners", () => {
    const m = qrMatrix(link);
    const n = m.length;
    for (const [r, c] of [[0, 0], [0, n - 7], [n - 7, 0]] as const) {
      expect(m[r]![c]).toBe(true);
      expect(m[r + 3]![c + 3]).toBe(true);
      expect(m[r + 1]![c + 1]).toBe(false);
    }
  });

  it("long links still fit", () => {
    const long = link + "&vault=" + "x".repeat(200);
    const { data, size } = rgba(qrMatrix(long), 3);
    expect(jsQR(data, size, size)?.data).toBe(long);
  });
});
