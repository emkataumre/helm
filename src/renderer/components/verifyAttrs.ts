// src/renderer/components/verifyAttrs.ts
// Build data-verify-* attributes from a map, stamping a component's derived state onto its root so
// the DOM itself is the machine-readable contract (the verification.md web pattern). Emits NOTHING
// in production — bundlers dead-code-eliminate this on NODE_ENV — so there's zero prod footprint.
export type VerifyValue = string | number | boolean | null | undefined;

export function verifyAttrs(attrs: Record<string, VerifyValue>): Record<string, string> {
    if (process.env.NODE_ENV === "production") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(attrs)) {
        if (v == null) continue;
        out[`data-verify-${k}`] = String(v);
    }
    return out;
}
