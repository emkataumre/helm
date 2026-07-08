// src/renderer/ds/forms.tsx — Input, Textarea, Select, Checkbox, Switch
// (styles in styles/ds.css). Ported from the Claude Design bundle's forms/ components.
import type { CSSProperties, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "prefix" | "className" | "style"> {
    size?: "sm" | "md" | "lg";
    icon?: ReactNode;
    prefix?: ReactNode;
    suffix?: ReactNode;
    error?: boolean;
    mono?: boolean;
    className?: string;
    style?: CSSProperties;
}

/** Single-line text input. Wraps an inset field with optional icon/affix. */
export function Input({ size = "md", icon, prefix, suffix, error = false, disabled = false, mono = false, className = "", style, ...rest }: InputProps) {
    const cls = ["helm-field", size !== "md" && `helm-field--${size}`, error && "helm-field--error", disabled && "helm-field--disabled", mono && "helm-field--mono", className].filter(Boolean).join(" ");
    return (
        <div className={cls} style={style}>
            {icon && <span className="helm-field__icon">{icon}</span>}
            {prefix && <span className="helm-field__affix">{prefix}</span>}
            <input disabled={disabled} {...rest} />
            {suffix && <span className="helm-field__affix">{suffix}</span>}
        </div>
    );
}

/** Multi-line text input. Use `mono` for prompts / config blocks. */
export function Textarea({ mono = false, className = "", ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) {
    return <textarea className={["helm-textarea", mono && "helm-textarea--mono", className].filter(Boolean).join(" ")} {...rest} />;
}

export type SelectOption = string | { value: string; label: string };

/** Native select styled to Helm. Pass options or children. */
export function Select({ size = "md", options, children, className = "", style, ...rest }: Omit<SelectHTMLAttributes<HTMLSelectElement>, "size" | "className" | "style"> & {
    size?: "sm" | "md";
    options?: SelectOption[];
    className?: string;
    style?: CSSProperties;
}) {
    const cls = ["helm-select", size !== "md" && `helm-select--${size}`, className].filter(Boolean).join(" ");
    return (
        <span className={cls} style={style}>
            <select {...rest}>
                {options
                    ? options.map((o) => {
                        const val = typeof o === "string" ? o : o.value;
                        const lbl = typeof o === "string" ? o : o.label;
                        return <option key={val} value={val}>{lbl}</option>;
                    })
                    : children}
            </select>
            <svg className="helm-select__chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
        </span>
    );
}

/** Checkbox with label. Controlled via `checked` or uncontrolled. */
export function Checkbox({ label, disabled = false, className = "", children, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "className"> & {
    label?: ReactNode;
    className?: string;
}) {
    const cls = ["helm-check", disabled && "helm-check--disabled", className].filter(Boolean).join(" ");
    return (
        <label className={cls}>
            <input type="checkbox" disabled={disabled} {...rest} />
            <span className="helm-check__box">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
            </span>
            {(label || children) && <span>{label || children}</span>}
        </label>
    );
}

/** Toggle switch for on/off settings. */
export function Switch({ label, disabled = false, className = "", children, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "className"> & {
    label?: ReactNode;
    className?: string;
}) {
    const cls = ["helm-switch", disabled && "helm-switch--disabled", className].filter(Boolean).join(" ");
    return (
        <label className={cls}>
            <input type="checkbox" role="switch" disabled={disabled} {...rest} />
            <span className="helm-switch__track"><span className="helm-switch__thumb" /></span>
            {(label || children) && <span>{label || children}</span>}
        </label>
    );
}
