// src/renderer/ds/data.tsx — Badge, Card, MetricStat, ProgressBar, StatusDot, StatusPill
// (styles in styles/ds.css). Ported from the Claude Design bundle's data/ components.
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import type { TaskStatus, IterationVerdict } from "../../shared/types";

export function Badge({ variant = "neutral", children, className = "", ...rest }: HTMLAttributes<HTMLSpanElement> & {
    variant?: "neutral" | "amber" | "success" | "danger" | "info" | "outline" | "solid";
}) {
    return <span className={["helm-badge", `helm-badge--${variant}`, className].filter(Boolean).join(" ")} {...rest}>{children}</span>;
}

/** Surface container. Panels, tiles, list items. */
export function Card({ title, headerRight, pad = false, interactive = false, selected = false, children, className = "", ...rest }: HTMLAttributes<HTMLDivElement> & {
    title?: ReactNode;
    headerRight?: ReactNode;
    pad?: boolean;
    interactive?: boolean;
    selected?: boolean;
}) {
    const cls = ["helm-card", pad && "helm-card--pad", interactive && "helm-card--interactive", selected && "helm-card--selected", className].filter(Boolean).join(" ");
    return (
        <div className={cls} {...rest}>
            {(title || headerRight) && (
                <div className="helm-card__header">
                    {title && <h3 className="helm-card__title">{title}</h3>}
                    {headerRight && <div style={{ marginLeft: "auto" }}>{headerRight}</div>}
                </div>
            )}
            {title || headerRight ? <div className="helm-card__body">{children}</div> : children}
        </div>
    );
}

/** Large labelled figure for telemetry / stat rows. */
export function MetricStat({ label, value, unit, delta, deltaDirection = "flat" }: {
    label?: ReactNode;
    value: ReactNode;
    unit?: ReactNode;
    delta?: ReactNode;
    deltaDirection?: "up" | "down" | "flat";
}) {
    return (
        <div className="helm-metric">
            {label && <span className="helm-metric__label">{label}</span>}
            <span className="helm-metric__value">
                {value}
                {unit && <span className="helm-metric__unit">{unit}</span>}
                {delta != null && (
                    <span className={`helm-metric__delta helm-metric__delta--${deltaDirection}`}>
                        {deltaDirection === "up" ? "▲" : deltaDirection === "down" ? "▼" : "·"} {delta}
                    </span>
                )}
            </span>
        </div>
    );
}

/** Determinate or indeterminate progress bar. */
export function ProgressBar({ value = 0, max = 100, tone = "primary", size = "md", indeterminate = false }: {
    value?: number;
    max?: number;
    tone?: "primary" | "running" | "failed";
    size?: "sm" | "md";
    indeterminate?: boolean;
}) {
    const pct = Math.max(0, Math.min(100, (value / max) * 100));
    const cls = ["helm-progress", size === "sm" && "helm-progress--sm", tone === "running" && "helm-progress--running", tone === "failed" && "helm-progress--failed", indeterminate && "helm-progress--indeterminate"].filter(Boolean).join(" ");
    return (
        <div className={cls} role="progressbar" aria-valuenow={indeterminate ? undefined : Math.round(pct)}>
            <div className="helm-progress__fill" style={{ width: indeterminate ? undefined : pct + "%" }} />
        </div>
    );
}

/** Task lifecycle statuses + the derived blocked/promoted views + gate verdicts — the LED vocabulary. */
export type LedStatus = TaskStatus | "blocked" | "promoted" | IterationVerdict;

/** Small status LED. `blocked` renders hollow. `pulse` only for running. */
export function StatusDot({ status = "queued", size = 8, pulse = false, style }: {
    status?: LedStatus;
    size?: number;
    pulse?: boolean;
    style?: CSSProperties;
}) {
    const cls = ["helm-dot", `helm-dot--${status}`, pulse && "helm-dot--pulse"].filter(Boolean).join(" ");
    return <span className={cls} style={{ width: size, height: size, ...style }} />;
}

/** Status pill: LED + lowercase label, colour-coded to the task lifecycle. */
export function StatusPill({ status = "queued", children, className = "", ...rest }: HTMLAttributes<HTMLSpanElement> & {
    status?: LedStatus;
    children?: ReactNode;
}) {
    return (
        <span className={["helm-pill", `helm-pill--${status}`, className].filter(Boolean).join(" ")} {...rest}>
            <StatusDot status={status} size={7} pulse={status === "running"} />
            {children ?? status}
        </span>
    );
}
