// src/renderer/components/PromoteResultPanel.tsx
// The "hand you the commands" surface for the M6-③ project-level batch Promote. Pure + prop-driven (no
// window.helm): the container runs the promote and feeds the PromoteResponse in. Stamps a data-verify-*
// contract (outcome / ready / command + pushed counts) read straight out of the static markup by the
// renderer verify slice. On `ready` it shows the diffstat, which helper refs the tool pushed, and the
// COPYABLE command list — the deliverable the human runs to advance the target (the tool never does).
import type { PromoteResponse } from "../../shared/types";
import { verifyAttrs } from "./verifyAttrs";

const mono = { fontFamily: "ui-monospace, monospace" as const };

export function PromoteResultPanel({ projectName, result }: {
    projectName: string;
    result: PromoteResponse | "loading";
}) {
    const outcome = result === "loading" ? "loading" : result.outcome;
    const ready = result !== "loading" && result.outcome === "ready";
    const commands = result !== "loading" && result.commands ? result.commands : [];
    const pushedRefs = result !== "loading" && result.pushedRefs ? result.pushedRefs : [];

    return (
        <div
            {...verifyAttrs({ unit: "PromoteResultPanel", project: projectName, outcome, ready, commands: commands.length, pushed: pushedRefs.length })}
            style={{ border: "1.5px solid #E3DACC", borderRadius: 12, padding: "12px 14px", display: "grid", gap: 10 }}
        >
            <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                <strong style={{ fontFamily: "ui-serif, Georgia, serif" }}>Promote — {projectName}</strong>
                <code style={{ ...mono, fontSize: 12, color: "#788C5D" }}>{outcome}</code>
            </div>
            {result === "loading" ? <p style={{ margin: 0, color: "#788C5D" }}>validating integration on a fresh origin tip…</p> : <Body result={result} pushedRefs={pushedRefs} commands={commands} />}
        </div>
    );
}

function Body({ result, pushedRefs, commands }: { result: PromoteResponse; pushedRefs: string[]; commands: string[] }) {
    switch (result.outcome) {
        case "nothing-to-promote":
            return <p style={{ margin: 0 }}>Nothing to promote — integration has no commits beyond the target.</p>;
        case "conflict":
            return <p style={{ margin: 0, color: "#D97757" }}>Integration does not merge cleanly onto the fresh target tip. Resolve the conflict on integration, then promote again.</p>;
        case "recheck-failed":
            return (
                <>
                    <p style={{ margin: 0, color: "#D97757" }}>The re-check failed on the fresh target tip — nothing was pushed.</p>
                    <pre style={{ ...mono, fontSize: 12, background: "#F0EEE6", padding: 10, borderRadius: 8, overflowX: "auto", margin: 0 }}>{result.output}</pre>
                </>
            );
        case "ready":
            return (
                <>
                    <div style={{ ...mono, fontSize: 12, color: "#3D3D3A" }}>
                        validated <code>{result.validatedSha.slice(0, 12)}</code> · {result.diffstat} · branch <code>{result.promoteBranch}</code>
                    </div>
                    {pushedRefs.length > 0 ? (
                        <div style={{ ...mono, fontSize: 12, color: "#788C5D" }}>the tool pushed: {pushedRefs.join(", ")}</div>
                    ) : (
                        <div style={{ ...mono, fontSize: 12, color: "#788C5D" }}>the tool pushed nothing (strict mode)</div>
                    )}
                    <div>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                            <span style={{ ...mono, fontSize: 12, textTransform: "uppercase", color: "#788C5D" }}>run these to advance the target</span>
                            <button onClick={() => navigator.clipboard?.writeText(commands.join("\n"))}>Copy</button>
                        </div>
                        <pre style={{ ...mono, fontSize: 13, background: "#F0EEE6", padding: 10, borderRadius: 8, overflowX: "auto", margin: 0 }}>{commands.join("\n")}</pre>
                    </div>
                </>
            );
    }
}
