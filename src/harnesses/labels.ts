import {
    EyeIcon,
    InfinityIcon,
    PencilSimpleIcon,
    type Icon
} from "@phosphor-icons/react";
import type { ReasoningLevel, SandboxLevel } from "@/proto";

export const REASONING_LABELS: Record<ReasoningLevel, string> = {
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Max"
};

export const SANDBOX_LEVELS: Record<
    SandboxLevel,
    { label: string; description: string; icon: Icon }
> = {
    "read-only": {
        label: "Read only",
        description: "Plans and reads; asks before changing anything",
        icon: EyeIcon
    },
    "workspace-write": {
        label: "Edit files",
        description: "Edits files freely; asks before commands",
        icon: PencilSimpleIcon
    },
    "danger-full-access": {
        label: "Full access",
        description: "Runs anything without asking",
        icon: InfinityIcon
    }
};
