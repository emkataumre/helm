// src/renderer/ds/feedback.tsx — Dialog, Toast, Tooltip (styles in styles/ds.css).
// Ported from the Claude Design bundle's feedback/ components. Toast keeps its inline
// SVG glyphs (self-contained, no icon-map dependency), exactly like the bundle.
import { useEffect } from "react";
import type { CSSProperties, ReactNode } from "react";

/** Modal dialog. Render conditionally on `open`; `onClose` fires on scrim/✕/Esc. */
export function Dialog({ open = true, onClose, title, description, footer, width, children }: {
    open?: boolean;
    onClose?: () => void;
    title?: ReactNode;
    description?: ReactNode;
    footer?: ReactNode;
    width?: number | string;
    children?: ReactNode;
}) {
    useEffect(() => {
        if (!open) return;
        const h = (e: KeyboardEvent) => { if (e.key === "Escape" && onClose) onClose(); };
        window.addEventListener("keydown", h);
        return () => window.removeEventListener("keydown", h);
    }, [open, onClose]);
    if (!open) return null;
    const style = width != null ? ({ "--_w": typeof width === "number" ? width + "px" : width } as CSSProperties) : undefined;
    return (
        <div className="helm-dialog__scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && onClose) onClose(); }}>
            <div className="helm-dialog" role="dialog" aria-modal="true" style={style}>
                {(title || onClose) && (
                    <div className="helm-dialog__header">
                        <div className="helm-dialog__titles">
                            {title && <h2 className="helm-dialog__title">{title}</h2>}
                            {description && <p className="helm-dialog__desc">{description}</p>}
                        </div>
                        {onClose && (
                            <button className="helm-dialog__x" aria-label="Close" onClick={onClose}>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                            </button>
                        )}
                    </div>
                )}
                {children && <div className="helm-dialog__body">{children}</div>}
                {footer && <div className="helm-dialog__footer">{footer}</div>}
            </div>
        </div>
    );
}

export type ToastTone = "info" | "success" | "warning" | "danger";

function ToastGlyph({ tone }: { tone: ToastTone }) {
    const paths: Record<string, string> = {
        info: "M12 16v-4M12 8h.01",
        success: "m9 12 2 2 4-4",
        warning: "M12 9v4M12 17h.01",
        danger: "m15 9-6 6M9 9l6 6",
    };
    return (
        <svg className="helm-toast__icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {tone === "warning"
                ? <><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" /><path d={paths.warning} /></>
                : <><circle cx="12" cy="12" r="10" /><path d={paths[tone]} /></>}
        </svg>
    );
}

/** Presentational toast. Feed from your own queue / stack. */
export function Toast({ tone = "info", title, children, onClose }: {
    tone?: ToastTone;
    title?: ReactNode;
    children?: ReactNode;
    onClose?: () => void;
}) {
    return (
        <div className={`helm-toast helm-toast--${tone}`} role="status">
            <ToastGlyph tone={tone} />
            <div className="helm-toast__body">
                {title && <div className="helm-toast__title">{title}</div>}
                {children && <div className="helm-toast__msg">{children}</div>}
            </div>
            {onClose && (
                <button className="helm-toast__x" aria-label="Dismiss" onClick={onClose}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                </button>
            )}
        </div>
    );
}

/** Hover/focus tooltip. Wraps its trigger children. */
export function Tooltip({ label, side = "top", children }: {
    label: ReactNode;
    side?: "top" | "bottom";
    children: ReactNode;
}) {
    return (
        <span className="helm-tt">
            {children}
            <span className={["helm-tt__pop", side === "bottom" && "helm-tt__pop--bottom"].filter(Boolean).join(" ")} role="tooltip">{label}</span>
        </span>
    );
}
