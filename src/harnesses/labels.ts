import type { AccessMode, ReasoningLevel } from "@/proto";

export const REASONING_LABELS: Record<ReasoningLevel, string> = {
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Max"
};

/** Every access mode, least to most trusting (the picker's order). */
export const ACCESS_MODES: AccessMode[] = ["supervised", "auto-accept-edits", "full-access"];

export const ACCESS_LABELS: Record<AccessMode, { label: string; description: string }> = {
    supervised: {
        label: "Supervised",
        description: "Asks before commands and edits"
    },
    "auto-accept-edits": {
        label: "Auto-accept edits",
        description: "Edits freely, asks for the rest"
    },
    "full-access": {
        label: "Full access",
        description: "Never asks first"
    }
};
