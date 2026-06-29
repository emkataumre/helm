// src/renderer/progress.ts
// Best-effort parse of the four known progress.md headings into sections, with a raw-markdown
// fallback for anything off-schema — never hard-require the structure (the agent owns the file).
export interface ProgressSections {
    currentFocus: string;
    done: string;
    remaining: string;
    triedAndRuledOut: string;
}
export interface ParsedProgress {
    ok: boolean;                    // true iff all four headings were found
    sections?: ProgressSections;    // present only when ok
    raw: string;                    // always — the fallback the panel renders off-schema
}

const HEADINGS: Array<[keyof ProgressSections, string]> = [
    ["currentFocus", "Current focus"],
    ["done", "Done"],
    ["remaining", "Remaining"],
    ["triedAndRuledOut", "Tried & ruled out"],
];

export function parseProgress(md: string): ParsedProgress {
    const raw = md ?? "";
    const byHeading = new Map<string, string[]>();
    let current: string | null = null;
    for (const line of raw.split(/\r?\n/)) {
        const m = /^##\s+(.+?)\s*$/.exec(line);
        if (m) { current = m[1].trim(); byHeading.set(current, []); continue; }
        if (current) byHeading.get(current)!.push(line);
    }

    const sections = {} as ProgressSections;
    let matched = 0;
    for (const [key, label] of HEADINGS) {
        const body = byHeading.get(label);
        if (body !== undefined) { matched += 1; sections[key] = body.join("\n").trim(); }
        else sections[key] = "";
    }
    return matched === HEADINGS.length ? { ok: true, sections, raw } : { ok: false, raw };
}
