// shuttle-admin CLI entry (dist/server/shuttle-admin.mjs). Commands live in ./adminCli.ts. AGPL-3.0-only.
// Env: SHUTTLE_DATA (default ~/tmp/claude/shuttle-dev-data; /data in the container).
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { expandHome } from "./config";
import { runAdmin } from "./adminCli";

export const ADMIN_ENTRY = "shuttle-admin";

async function readPassword(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (prompt === "" || !stdin.isTTY) {
    // --password-stdin or piped input: the first line.
    const rl = createInterface({ input: stdin });
    for await (const line of rl) { rl.close(); return line; }
    return "";
  }
  process.stderr.write(prompt);
  return await new Promise<string>((resolve) => {
    let buf = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n" || c === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          resolve(buf);
          return;
        }
        if (c === "\u0003") { stdin.setRawMode(false); process.exit(130); }
        if (c === "\u007f") buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on("data", onData);
  });
}

const dataDir = expandHome(process.env.SHUTTLE_DATA || path.join(os.homedir(), "tmp/claude/shuttle-dev-data"));
process.exitCode = await runAdmin(process.argv.slice(2), {
  dataDir,
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
  readPassword,
});
