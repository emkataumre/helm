// src/renderer/components/IterationHistory.tsx
import type { IterationView } from "../../shared/types";
import { verifyAttrs } from "./verifyAttrs";

const fmtDuration = (ms: number | null) => (ms == null ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

// Pure, prop-driven. One row per iteration: verdict, tokens, duration. Stamps the row count.
export function IterationHistory({ iterations }: { iterations: IterationView[] }) {
    return (
        <table className="iteration-history" {...verifyAttrs({ unit: "IterationHistory", count: iterations.length })} style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
                <tr style={{ textAlign: "left", color: "#888" }}>
                    <th>#</th><th>verdict</th><th>out tokens</th><th>cost</th><th>duration</th>
                </tr>
            </thead>
            <tbody>
                {iterations.map((it) => (
                    <tr key={it.index} data-verdict={it.verdict ?? "pending"}>
                        <td>{it.index}</td>
                        <td>{it.verdict ?? "…"}</td>
                        <td>{it.tokens.output.toLocaleString()}</td>
                        <td>${it.tokens.costUsd.toFixed(4)}</td>
                        <td>{fmtDuration(it.durationMs)}</td>
                    </tr>
                ))}
                {iterations.length === 0 ? <tr><td colSpan={5} style={{ color: "#888" }}>(no iterations yet)</td></tr> : null}
            </tbody>
        </table>
    );
}
