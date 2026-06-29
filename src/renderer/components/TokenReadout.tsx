// src/renderer/components/TokenReadout.tsx
import type { TokenTotals, IterationView } from "../../shared/types";
import { verifyAttrs } from "./verifyAttrs";

const DIMS: Array<keyof TokenTotals> = ["input", "output", "cacheRead", "cacheCreation", "costUsd"];

// Pure, prop-driven. Stamps the displayed totals + a `consistent` flag = "the displayed total
// equals the sum of the per-iteration series" (every dimension). The flag is the verify contract:
// if the readout ever shows a total that doesn't reconcile, data-verify-consistent goes false.
export function TokenReadout({ totals, iterations }: { totals: TokenTotals; iterations: IterationView[] }) {
    const summed = (d: keyof TokenTotals) => iterations.reduce((s, it) => s + it.tokens[d], 0);
    const consistent = DIMS.every((d) => Math.abs(summed(d) - totals[d]) < 1e-9);
    return (
        <div
            className="token-readout"
            {...verifyAttrs({
                // Lowercase keys only — React mangles camelCase data-* suffixes. The `consistent`
                // flag (reconciliation across ALL dims, incl. cache) is the load-bearing contract.
                unit: "TokenReadout",
                input: totals.input, output: totals.output, cost: totals.costUsd, consistent,
            })}
        >
            <span>in {totals.input.toLocaleString()}</span>{" · "}
            <span>out {totals.output.toLocaleString()}</span>{" · "}
            <span>cache r/w {totals.cacheRead.toLocaleString()}/{totals.cacheCreation.toLocaleString()}</span>{" · "}
            <span>${totals.costUsd.toFixed(4)}</span>
        </div>
    );
}
