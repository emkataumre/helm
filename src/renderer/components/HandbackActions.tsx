// src/renderer/components/HandbackActions.tsx
import type { TaskStatus } from "../../shared/types";
import { verifyAttrs } from "./verifyAttrs";

// The drop-in hand-back trio, shown in TaskDetail only when the task is handed-off (spec §8): Resume
// loop / Verify & merge / Abandon. Pure + prop-driven (react-dom/server-testable, the M3/M4 way); the
// container wires the actions. Also surfaces a terminal-launch error if the drop-in launch failed.
export function HandbackActions({ status, launchError, onResume, onVerifyAndMerge, onAbandon }: {
    status: TaskStatus;
    launchError?: string | null;
    onResume?: () => void;
    onVerifyAndMerge?: () => void;
    onAbandon?: () => void;
}) {
    const handedOff = status === "handed-off";
    return (
        <div {...verifyAttrs({ unit: "HandbackActions", status, handback: handedOff })} style={{ display: "grid", gap: 8 }}>
            {launchError ? <div style={{ color: "#b00", fontSize: 12 }}>{launchError}</div> : null}
            {handedOff ? (
                <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={onResume}>Resume loop</button>
                    <button onClick={onVerifyAndMerge}>Verify &amp; merge</button>
                    <button onClick={onAbandon}>Abandon</button>
                </div>
            ) : null}
        </div>
    );
}
