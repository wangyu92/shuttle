// QR code for the "Add device" enrollment link (design §5.5.9): drawn into a <canvas> by a bundled MIT
// encoder (qrcode-generator), no network. Black modules on white with a 4-module quiet zone whatever
// the theme, so phone cameras read it in dark mode too.

import qrcode from "qrcode-generator";

export const QUIET_ZONE = 4;

/** Module matrix (true = dark) for `text`, error correction M, smallest version that fits. */
export function qrMatrix(text: string): boolean[][] {
  const q = qrcode(0, "M");
  q.addData(text, "Byte");
  q.make();
  const n = q.getModuleCount();
  const rows: boolean[][] = [];
  for (let r = 0; r < n; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < n; c++) row.push(q.isDark(r, c));
    rows.push(row);
  }
  return rows;
}

/** Draw `text` into `canvas`, about `targetPx` CSS pixels wide, sharp on high-DPI screens. */
export function drawQr(canvas: HTMLCanvasElement, text: string, targetPx = 220, dpr = 1): void {
  const m = qrMatrix(text);
  const cells = m.length + QUIET_ZONE * 2;
  const scale = Math.max(2, Math.floor((targetPx * dpr) / cells));
  canvas.width = cells * scale;
  canvas.height = cells * scale;
  canvas.style.width = `${Math.round((cells * scale) / dpr)}px`;
  canvas.style.height = canvas.style.width;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000000";
  for (let r = 0; r < m.length; r++) {
    const row = m[r]!;
    for (let c = 0; c < row.length; c++) if (row[c]) ctx.fillRect((c + QUIET_ZONE) * scale, (r + QUIET_ZONE) * scale, scale, scale);
  }
}
