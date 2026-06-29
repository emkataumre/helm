// src/renderer/components/ProgressPanel.tsx
import type { ParsedProgress, ProgressSections } from "../progress";
import { verifyAttrs } from "./verifyAttrs";

const SECTION_LABELS: Array<[keyof ProgressSections, string]> = [
    ["currentFocus", "Current focus"],
    ["done", "Done"],
    ["remaining", "Remaining"],
    ["triedAndRuledOut", "Tried & ruled out"],
];

// Pure, prop-driven, read-only. Renders the four sections when the file parses (structured), else
// falls back to raw markdown; reports unavailable when there's no progress file (worktree gone).
export function ProgressPanel({ progress }: { progress: ParsedProgress | null }) {
    if (!progress) {
        return <div className="progress-panel" {...verifyAttrs({ unit: "ProgressPanel", available: false })} style={{ color: "#888" }}>No progress file (worktree removed).</div>;
    }
    const sections = progress.ok ? progress.sections : undefined;
    return (
        <div className="progress-panel" {...verifyAttrs({ unit: "ProgressPanel", available: true, structured: progress.ok })}>
            {sections ? (
                SECTION_LABELS.map(([key, label]) => (
                    <section key={key} style={{ marginBottom: 8 }}>
                        <h4 style={{ margin: "4px 0", fontFamily: "ui-serif, Georgia, serif" }}>{label}</h4>
                        <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12 }}>{sections[key] || "—"}</pre>
                    </section>
                ))
            ) : (
                <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{progress.raw}</pre>
            )}
        </div>
    );
}
