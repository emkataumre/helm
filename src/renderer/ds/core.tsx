// src/renderer/ds/core.tsx — Button, IconButton, Kbd (styles in styles/ds.css).
// Ported from the Claude Design bundle's core/ components; markup and class names verbatim.
import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: "primary" | "secondary" | "ghost" | "outline" | "danger";
    size?: "sm" | "md" | "lg";
    loading?: boolean;
    fullWidth?: boolean;
    iconLeft?: ReactNode;
    iconRight?: ReactNode;
}

/** Primary action button. Amber = the one committing action per view. */
export function Button({ variant = "primary", size = "md", disabled = false, loading = false, fullWidth = false, iconLeft, iconRight, children, className = "", style, ...rest }: ButtonProps) {
    const cls = ["helm-btn", `helm-btn--${variant}`, size !== "md" && `helm-btn--${size}`, className].filter(Boolean).join(" ");
    return (
        <button className={cls} disabled={disabled || loading} style={fullWidth ? { width: "100%", ...style } : style} {...rest}>
            {loading && <span className="helm-btn__spin" />}
            {!loading && iconLeft}
            {children != null && children !== false ? <span>{children}</span> : null}
            {!loading && iconRight}
        </button>
    );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: "ghost" | "solid";
    size?: "sm" | "md" | "lg";
    active?: boolean;
    label: string; // accessible name (also the hover title)
}

/** Square icon-only control. Provide an accessible label. */
export function IconButton({ variant = "ghost", size = "md", active = false, label, children, className = "", ...rest }: IconButtonProps) {
    const cls = ["helm-iconbtn", variant === "solid" && "helm-iconbtn--solid", active && "helm-iconbtn--active", size !== "md" && `helm-iconbtn--${size}`, className].filter(Boolean).join(" ");
    return (
        <button className={cls} aria-label={label} title={label} {...rest}>{children}</button>
    );
}

const KBD_SYMBOLS: Record<string, string> = {
    mod: "⌘", cmd: "⌘", ctrl: "⌃", alt: "⌥", opt: "⌥", shift: "⇧",
    enter: "↵", esc: "Esc", tab: "⇥", up: "↑", down: "↓", left: "←", right: "→",
};

/** Renders a keyboard shortcut as styled key caps. */
export function Kbd({ keys = [] }: { keys: string[] }) {
    return (
        <span className="helm-kbd">
            {keys.map((k, i) => <kbd key={i}>{KBD_SYMBOLS[String(k).toLowerCase()] ?? k}</kbd>)}
        </span>
    );
}
