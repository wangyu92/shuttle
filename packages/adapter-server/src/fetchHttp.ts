// HttpClient over the WHATWG fetch API (headless on Node 22, tests). The plugin uses Obsidian's
// requestUrl instead (CORS-free, design §2.12); that wrapper lives in the plugin package.

import type { HttpClient, HttpRequest, HttpResponse } from "@shuttle/protocol";

type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body?: ArrayBuffer | string; signal?: AbortSignal }) => Promise<{
  status: number; headers: { forEach(cb: (value: string, key: string) => void): void }; arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** `fetchFn` defaults to globalThis.fetch. Aborts the request at `timeoutMs`. */
export function fetchHttpClient(fetchFn?: FetchFn): HttpClient {
  const f: FetchFn = fetchFn ?? ((url, init) => (globalThis.fetch as unknown as FetchFn)(url, init));
  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const t = setTimeout(() => ctl?.abort(), req.timeoutMs);
      try {
        const init: Parameters<FetchFn>[1] = { method: req.method, headers: req.headers ?? {} };
        if (req.body !== undefined) init.body = req.body;
        if (ctl) init.signal = ctl.signal;
        const res = await f(req.url, init);
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
        const body = req.method === "HEAD" ? new ArrayBuffer(0) : await res.arrayBuffer();
        return { status: res.status, headers, body };
      } catch (e) {
        if (ctl?.signal.aborted) throw new Error(`request timed out after ${req.timeoutMs} ms`);
        throw e;
      } finally {
        clearTimeout(t);
      }
    },
  };
}
