// src/main/ctl/cli.ts
// The `helm` CLI — the tracked client of the blessed control pipe (spec §3). Built as a SECOND rollup
// entry (out/main/cli.js, see electron.vite.config.ts) and invoked via the PATH shims Helm writes under
// userData — it runs under the plain `node` on PATH and NEVER loads Electron (node builtins only).
// Reads HELM_CTL_PIPE from the env (injected into HUMAN PTYs only), sends one JSON request with the
// caller's cwd (so `helm plan status` scopes to the repo it runs in), prints the JSON response.
// A connect failure SAYS Helm isn't running, plainly — a dead pipe must never read as an empty board.
import { connect } from "node:net";
import { parseCliArgs, type CtlResponse } from "./protocol";

const parsed = parseCliArgs(process.argv.slice(2));
if (!parsed.ok) {
    console.error(parsed.error);
    process.exit(2);
}

const pipe = process.env.HELM_CTL_PIPE;
if (!pipe) {
    console.error("HELM_CTL_PIPE is not set — run `helm` inside a Helm-hosted terminal (conductor pane or a free terminal); Helm injects the control pipe there and nowhere else.");
    process.exit(1);
}

const sock = connect(pipe);
let buf = "";
sock.setEncoding("utf8");
sock.setTimeout(15_000, () => {
    console.error("Helm did not answer on its control pipe within 15s — the app may be wedged. This is a transport failure, NOT an empty board.");
    sock.destroy();
    process.exit(1);
});
sock.on("error", (err: NodeJS.ErrnoException) => {
    console.error(`Helm is not reachable on its control pipe (${err.code ?? err.message}). Is the Helm app running? This is a connection failure, NOT an empty board.`);
    process.exit(1);
});
sock.on("connect", () => {
    sock.write(JSON.stringify({ ...parsed.request, cwd: process.cwd() }) + "\n");
});
sock.on("data", (chunk: string) => { buf += chunk; });
sock.on("end", () => {
    let resp: CtlResponse;
    try { resp = JSON.parse(buf.trim()) as CtlResponse; }
    catch {
        console.error(`malformed response from Helm: ${buf.slice(0, 200)}`);
        process.exit(1);
    }
    if (resp.ok) {
        console.log(JSON.stringify(resp.data, null, 2));
    } else {
        console.error(`helm: ${resp.error}`);
        process.exit(1);
    }
});
