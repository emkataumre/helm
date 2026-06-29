// src/renderer/components/ActivityFeed.tsx
import type { ActivityEntry } from "../../shared/types";
import { verifyAttrs } from "./verifyAttrs";

const KIND_LABEL: Record<ActivityEntry["kind"], string> = { assistant: "💬", "tool-use": "🔧", gate: "✓" };

// Pure, prop-driven. The parsed §5.6 events, newest last. Stamps the entry count as its contract.
export function ActivityFeed({ feed }: { feed: ActivityEntry[] }) {
    return (
        <ul className="activity-feed" {...verifyAttrs({ unit: "ActivityFeed", count: feed.length })} style={{ listStyle: "none", padding: 0, margin: 0, maxHeight: 260, overflowY: "auto" }}>
            {feed.map((e, i) => (
                <li key={i} data-kind={e.kind} style={{ padding: "2px 0", fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
                    <span title={e.kind}>{KIND_LABEL[e.kind]}</span> <span style={{ color: "#888" }}>#{e.iterationIndex}</span> {e.text}
                </li>
            ))}
            {feed.length === 0 ? <li style={{ color: "#888" }}>(no activity yet)</li> : null}
        </ul>
    );
}
