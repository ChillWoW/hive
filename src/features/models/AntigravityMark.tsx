import { useId } from "react";
import { cn } from "@/lib/cn";

/** Google Antigravity's arch, in Google's colours on any surface. */
export function AntigravityMark({ className }: { className?: string }) {
    const gradient = useId();
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className={cn("shrink-0", className)}>
            <defs>
                <linearGradient id={gradient} x1="0" y1="1" x2="1" y2="0">
                    <stop offset="0" stopColor="#3186FF" />
                    <stop offset="0.35" stopColor="#00B95C" />
                    <stop offset="0.65" stopColor="#FBBC04" />
                    <stop offset="1" stopColor="#FC413D" />
                </linearGradient>
            </defs>
            <path
                fill={`url(#${gradient})`}
                d="M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z"
            />
        </svg>
    );
}
