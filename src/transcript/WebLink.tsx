import { useState, type ComponentProps, type ReactNode } from "react";
import { GlobeIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/ui";

/** Hosts whose favicon didn't load: the globe from then on, no retry per link. */
const missing = new Set<string>();

const hostOf = (href: string) => {
    try {
        const url = new URL(href);
        return /^https?:$/.test(url.protocol) ? url.hostname : null;
    } catch {
        return null;
    }
};

/** The site's favicon (DuckDuckGo's icon service), else a globe. */
function SiteIcon({ host }: { host: string }) {
    const [failed, setFailed] = useState(() => missing.has(host));
    if (failed) return <GlobeIcon className={cn(LINK_ICON_CLASS, "text-dark-200")} weight="regular" />;
    return (
        <img
            src={`https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`}
            alt=""
            aria-hidden="true"
            draggable={false}
            loading="lazy"
            referrerPolicy="no-referrer"
            className={cn(LINK_ICON_CLASS, "rounded-[3px] object-contain select-none")}
            onError={() => {
                missing.add(host);
                setFailed(true);
            }}
        />
    );
}

/** The icon before a link's label, sat on the text's line. */
export const LINK_ICON_CLASS = "mr-1 inline-block size-3.5 translate-y-[-1px] align-middle";

export const LINK_CLASS =
    "inline cursor-pointer text-left text-info decoration-info/50 underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none";

/**
 * A web link in agent text, drawn as `FileLink` draws a file: the site's
 * icon and the label in blue, the URL in a tooltip. Opening it is left to
 * whoever handles link clicks (the system browser, from `Markdown`).
 */
export function WebLink({
    href,
    children,
    className,
    ...props
}: ComponentProps<"a"> & { href: string; children?: ReactNode }) {
    const host = hostOf(href);
    return (
        <Tooltip>
            <Tooltip.Trigger
                render={
                    <a
                        {...props}
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                        data-streamdown="link"
                        className={cn(LINK_CLASS, "wrap-anywhere", className)}
                    >
                        {host && <SiteIcon host={host} />}
                        {children}
                    </a>
                }
            />
            <Tooltip.Content side="top">{href}</Tooltip.Content>
        </Tooltip>
    );
}
