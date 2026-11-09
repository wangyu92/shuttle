// HttpClient over Obsidian's requestUrl (design §2.12: CORS-free on every platform).
// requestUrl has no timeout and no abort (design §2.8.5), so the request races a timer; a late answer
// is dropped. `throw: false` returns 4xx/5xx as responses so the adapter maps them to RemoteErrors.

import type { HttpClient, HttpRequest, HttpResponse } from "@shuttle/protocol";
import { redact } from "../util/redact";

/** The part of Obsidian's requestUrl this client uses (injected for tests). */
export type RequestUrlFn = (p: {
  url: string; method?: string; contentType?: string; body?: string | ArrayBuffer; headers?: Record<string, string>; throw?: boolean;
}) => Promise<{ status: number; headers: Record<string, string>; arrayBuffer: ArrayBuffer }>;

export interface TimerFns {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

const defaultTimers: TimerFns = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class HttpTimeoutError extends Error {
  constructor(ms: number) {
    super(`request timed out after ${ms} ms`);
    this.name = "HttpTimeoutError";
  }
}

export function requestUrlHttpClient(requestUrl: RequestUrlFn, timers: TimerFns = defaultTimers): HttpClient {
  return {
    request(req: HttpRequest): Promise<HttpResponse> {
      const headers: Record<string, string> = {};
      let contentType: string | undefined;
      for (const [k, v] of Object.entries(req.headers ?? {})) {
        // requestUrl takes the content type separately; passing it twice confuses some platforms.
        if (k.toLowerCase() === "content-type") contentType = v;
        else headers[k] = v;
      }
      const param: Parameters<RequestUrlFn>[0] = { url: req.url, method: req.method, headers, throw: false };
      if (contentType !== undefined) param.contentType = contentType;
      if (req.body !== undefined) param.body = req.body;
      return new Promise<HttpResponse>((resolve, reject) => {
        let done = false;
        const t = timers.setTimeout(() => {
          if (done) return;
          done = true;
          reject(new HttpTimeoutError(req.timeoutMs));
        }, req.timeoutMs);
        requestUrl(param).then(
          (res) => {
            if (done) return;
            done = true;
            timers.clearTimeout(t);
            const out: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers ?? {})) out[k.toLowerCase()] = String(v);
            let body: ArrayBuffer;
            try {
              body = req.method === "HEAD" ? new ArrayBuffer(0) : res.arrayBuffer ?? new ArrayBuffer(0);
            } catch {
              body = new ArrayBuffer(0);
            }
            resolve({ status: res.status, headers: out, body });
          },
          (e: unknown) => {
            if (done) return;
            done = true;
            timers.clearTimeout(t);
            // requestUrl errors can echo the request; never let a token reach a log line.
            reject(new Error(redact(e instanceof Error ? e.message : String(e))));
          },
        );
      });
    },
  };
}
