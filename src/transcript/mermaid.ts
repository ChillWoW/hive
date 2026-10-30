import type { MermaidConfig } from "mermaid";
import type { DiagramPlugin } from "streamdown";

/** Mermaid in the app's palette: dark surfaces, hairline borders, its sans type. */
const CONFIG: MermaidConfig = {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: "base",
    fontFamily: "system-ui, sans-serif",
    themeVariables: {
        darkMode: true,
        background: "transparent",
        fontFamily: "system-ui, sans-serif",
        fontSize: "13px",
        primaryColor: "#242424",
        primaryTextColor: "#c9c9c9",
        primaryBorderColor: "#424242",
        secondaryColor: "#1f1f1f",
        secondaryTextColor: "#b8b8b8",
        secondaryBorderColor: "#3b3b3b",
        tertiaryColor: "#1a1a1a",
        tertiaryTextColor: "#b8b8b8",
        tertiaryBorderColor: "#3b3b3b",
        lineColor: "#696969",
        textColor: "#b8b8b8",
        mainBkg: "#242424",
        nodeBorder: "#424242",
        clusterBkg: "#1a1a1a",
        clusterBorder: "#3b3b3b",
        edgeLabelBackground: "#1a1a1a",
        noteBkgColor: "#2e2e2e",
        noteTextColor: "#c9c9c9",
        noteBorderColor: "#424242",
        actorBkg: "#242424",
        actorBorder: "#424242",
        actorTextColor: "#c9c9c9",
        signalColor: "#828282",
        signalTextColor: "#b8b8b8",
        labelBoxBkgColor: "#242424",
        labelBoxBorderColor: "#424242",
        labelTextColor: "#c9c9c9",
        errorBkgColor: "#2e2e2e",
        errorTextColor: "#ff616e"
    }
};

type Mermaid = typeof import("mermaid").default;

let loading: Promise<Mermaid> | undefined;
let config: MermaidConfig = CONFIG;
let applied: MermaidConfig | undefined;

/** Mermaid is ~1 MB; it's fetched the first time a diagram is drawn. */
function load(): Promise<Mermaid> {
    loading ??= import("mermaid").then((m) => m.default);
    return loading;
}

/**
 * Streamdown's diagram plugin, as `@streamdown/mermaid` builds it, but with
 * Mermaid imported lazily rather than in the main chunk.
 */
export const mermaid: DiagramPlugin = {
    name: "mermaid",
    type: "diagram",
    language: "mermaid",
    getMermaid(extra?: MermaidConfig) {
        if (extra) config = { ...CONFIG, ...extra };
        return {
            initialize(next: MermaidConfig) {
                config = { ...CONFIG, ...next };
            },
            async render(id: string, source: string) {
                const instance = await load();
                if (applied !== config) {
                    instance.initialize(config);
                    applied = config;
                }
                return instance.render(id, source);
            }
        };
    }
};
