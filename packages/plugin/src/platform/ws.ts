// WsFactory over the browser WebSocket (design §2.9). The server sends text frames only; a binary
// frame is decoded as UTF-8 so the feed parser reports it instead of the socket silently dropping it.

import type { WsFactory, WsLike } from "@shuttle/protocol";

export interface BrowserWebSocket {
  readonly readyState: number;
  readonly protocol: string;
  binaryType: string;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type WebSocketCtor = new (url: string, protocols?: string | string[]) => BrowserWebSocket;

const td = new TextDecoder();

export function browserWsFactory(Ctor: WebSocketCtor): WsFactory {
  return (url: string, protocols: string[]): WsLike => {
    const ws = new Ctor(url, protocols);
    ws.binaryType = "arraybuffer";
    const like: WsLike = {
      send: (d) => ws.send(d),
      close: (code, reason) => ws.close(code, reason),
      get readyState() { return ws.readyState; },
      get protocol() { return ws.protocol; },
      onopen: null, onmessage: null, onclose: null, onerror: null,
    };
    ws.onopen = () => like.onopen?.();
    ws.onmessage = (ev) => {
      const d = ev.data;
      const text = typeof d === "string" ? d : d instanceof ArrayBuffer ? td.decode(new Uint8Array(d)) : String(d);
      like.onmessage?.({ data: text });
    };
    ws.onclose = (ev) => like.onclose?.({ code: ev.code, reason: ev.reason });
    ws.onerror = (ev) => like.onerror?.(ev);
    return like;
  };
}
