// src/renderer/ds/Icon.tsx
// Thin Lucide wrapper standardising stroke/size to brand (DS readme: 1.75–2px stroke,
// currentColor). The design references glyphs by name string; a curated static map keeps
// the bundle tree-shaken to just the glyphs the cockpit uses, and tsc verifies every name
// against lucide-react's exports. `TerminalSquare` is the design's name for what lucide
// now exports as SquareTerminal.
import type { CSSProperties } from "react";
import {
    Anchor, ArrowLeft, ArrowUpRight, Ban, Bot, CalendarRange, Check, ChevronDown, ChevronRight, ChevronUp,
    Circle, CircleCheck, CircleDot, Columns3, Container, Copy, Crosshair, Dot, Ellipsis,
    FileText, Filter, FolderGit2, GitBranch, GitCompare, GitMerge, Inbox, Info, LayoutGrid, List, ListTodo,
    Loader, Lock, Map, MessageSquare, OctagonAlert, Pause, Play, Plus, RefreshCw, ScanSearch,
    ScrollText, Settings2, ShieldCheck, SquareChevronRight, SquareTerminal, Terminal,
    TriangleAlert, Trash2, Unlink, Wrench, X,
} from "lucide-react";

const ICONS = {
    Anchor, ArrowLeft, ArrowUpRight, Ban, Bot, CalendarRange, Check, ChevronDown, ChevronRight, ChevronUp,
    Circle, CircleCheck, CircleDot, Columns3, Container, Copy, Crosshair, Dot, Ellipsis,
    FileText, Filter, FolderGit2, GitBranch, GitCompare, GitMerge, Inbox, Info, LayoutGrid, List, ListTodo,
    Loader, Lock, Map, MessageSquare, OctagonAlert, Pause, Play, Plus, RefreshCw, ScanSearch,
    ScrollText, Settings2, ShieldCheck, SquareChevronRight, SquareTerminal, Terminal,
    TerminalSquare: SquareTerminal,
    TriangleAlert, Trash2, Unlink, Wrench, X,
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16, strokeWidth = 2, style }: {
    name: IconName;
    size?: number;
    strokeWidth?: number;
    style?: CSSProperties;
}) {
    const Glyph = ICONS[name];
    return <Glyph size={size} strokeWidth={strokeWidth} aria-hidden style={{ display: "block", flex: "none", ...style }} />;
}
