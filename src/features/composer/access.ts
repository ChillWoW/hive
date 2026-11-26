import { LockSimpleIcon, LockSimpleOpenIcon, PencilSimpleIcon } from "@phosphor-icons/react";
import type { AccessMode } from "@/proto";

/** The access modes, least to most trusting: what a chat's agent may do without asking. */
export const ACCESS_MODES: { id: AccessMode; label: string; description: string; icon: typeof LockSimpleIcon }[] = [
    {
        id: "supervised",
        label: "Supervised",
        description: "Asks before commands and edits",
        icon: LockSimpleIcon
    },
    {
        id: "auto-accept-edits",
        label: "Auto-accept edits",
        description: "Edits freely, asks for the rest",
        icon: PencilSimpleIcon
    },
    {
        id: "full-access",
        label: "Full access",
        description: "Never asks first",
        icon: LockSimpleOpenIcon
    }
];
