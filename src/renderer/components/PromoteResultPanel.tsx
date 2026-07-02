// src/renderer/components/PromoteResultPanel.tsx
// The result surface for the M6-③ project-level batch Promote. Pure + prop-driven (no window.helm): the
// container runs the promote and feeds the PromoteResponse in. Stamps a data-verify-* contract
// (outcome / ready / advanced / command + pushed counts) read straight out of the static markup by the
// renderer verify slice. On a `direct` graduation it shows that the target was ADVANCED on your click (to
// the exact re-validated commit); for `pr`/`strict` it shows what was pushed + the copyable command(s).
import type { PromoteResponse } from "../../shared/types";
import { verifyAttrs } from "./verifyAttrs";

const mono = { fontFamily: "ui-monospace, monospace" as const };
const preStyle = { ...mono, fontSize: 13, background: "#F0EEE6", padding: 10, borderRadius: 8, overflowX: "auto" as const, margin: 0 };

export function PromoteResultPanel({ projectName, result }: {
    projectName: string;
    result: PromoteResponse | "loading";
}) {
    const outcome = result === "loading" ? "loading" : result.outcome;
    const ready = result !== "loading" && result.outcome === "ready";
    const advanced = result !== "loading" && result.advancedTarget === true;
    const commands = result !== "loading" && result.commands ? result.commands : [];
    const pushedRefs = result !== "loading" && result.pushedRefs ? result.pushedRefs : [];

    return (
        <div
            {...verifyAttrs({ unit: "PromoteResultPanel", project: projectName, outcome, ready, advanced, commands: commands.length, pushed: pushedRefs.length })}
            style={{ border: "1.5px solid #E3DACC", borderRadius: 12, padding: "12px 14px", display: "grid", gap: 10 }}
        >
            <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                <strong style={{ fontFamily: "ui-serif, Georgia, serif" }}>Promote — {projectName}</strong>
                <code style={{ ...mono, fontSize: 12, color: "#788C5D" }}>{outcome}</code>
            </div>
            {result === "loading" ? <p style={{ margin: 0, color: "#788C5D" }}>validating integration on a fresh origin tip…</p> : <Body result={result} commands={commands} />}
        </div>
    );
}

function Body({ result, commands }: { result: PromoteResponse; commands: string[] }) {
    switch (result.outcome) {
        case "nothing-to-promote":
            return <p style={{ margin: 0 }}>Nothing to promote — integration has no commits beyond the target.</p>;
        case "conflict":
            return <p style={{ margin: 0, color: "#D97757" }}>Integration does not merge cleanly onto the fresh target tip. Resolve the conflict on integration, then promote again.</p>;
        case "recheck-failed":
            return (
                <>
                    <p style={{ margin: 0, color: "#D97757" }}>The re-check failed on the fresh target tip — nothing was pushed.</p>
                    <pre style={preStyle}>{result.output}</pre>
                </>
            );
        case "ready":
            return (
                <>
                    <div style={{ ...mono, fontSize: 12, color: "#3D3D3A" }}>
                        validated <code>{result.validatedSha.slice(0, 12)}</code> · {result.diffstat}
                    </div>
                    {/* The headline: what actually happened on your click. */}
                    {result.advancedTarget ? (
                        <div style={{ ...mono, fontSize: 13, color: "#788C5D" }}>✓ {result.note}</div>
                    ) : result.error ? (
                        <>
                            <div style={{ ...mono, fontSize: 13, color: "#D97757" }}>{result.note}</div>
                            <pre style={preStyle}>{result.error}</pre>
                        </>
                    ) : (
                        <div style={{ ...mono, fontSize: 13, color: "#788C5D" }}>{result.note}</div>
                    )}
                    {/* The command(s): a retry (direct failure), the gh open-PR step (pr), or the full sequence (strict).
                        On a clean direct advance this is just the audit trail of what ran. */}
                    {commands.length > 0 ? (
                        <div>
                            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                                <span style={{ ...mono, fontSize: 12, textTransform: "uppercase", color: "#788C5D" }}>
                                    {result.advancedTarget ? "what ran" : "run this"}
                                </span>
                                <button onClick={() => navigator.clipboard?.writeText(commands.join("\n"))}>Copy</button>
                            </div>
                            <pre style={preStyle}>{commands.join("\n")}</pre>
                        </div>
                    ) : null}
                </>
            );
    }
}
