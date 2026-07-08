// src/renderer/ds/Tabs.tsx — underline tab bar (styles in styles/ds.css).
// Controlled (`value`+`onChange`) or uncontrolled (`defaultValue`).
import { useState } from "react";
import type { ReactNode } from "react";

export interface TabItem {
    id: string;
    label: ReactNode;
    icon?: ReactNode;
    count?: number;
}

export function Tabs({ items = [], value, defaultValue, onChange }: {
    items: TabItem[];
    value?: string;
    defaultValue?: string;
    onChange?: (id: string) => void;
}) {
    const [internal, setInternal] = useState(defaultValue ?? items[0]?.id);
    const active = value !== undefined ? value : internal;
    const select = (id: string) => {
        if (value === undefined) setInternal(id);
        onChange?.(id);
    };
    return (
        <div className="helm-tabs" role="tablist">
            {items.map((it) => (
                <button
                    key={it.id} role="tab" aria-selected={active === it.id}
                    className={["helm-tab", active === it.id && "helm-tab--active"].filter(Boolean).join(" ")}
                    onClick={() => select(it.id)}
                >
                    {it.icon}{it.label}
                    {it.count != null && <span className="helm-tab__count">{it.count}</span>}
                </button>
            ))}
        </div>
    );
}
