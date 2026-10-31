import type { MermaidConfig } from "mermaid";
import type { DiagramPlugin } from "streamdown";
import { DARK } from "@/lib/palette";

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
        primaryColor: DARK[700],
        primaryTextColor: DARK[50],
        primaryBorderColor: DARK[400],
        secondaryColor: DARK[800],
        secondaryTextColor: DARK[100],
        secondaryBorderColor: DARK[500],
        tertiaryColor: DARK[850],
        tertiaryTextColor: DARK[100],
        tertiaryBorderColor: DARK[500],
        lineColor: DARK[300],
        textColor: DARK[100],
        mainBkg: DARK[700],
        nodeBorder: DARK[400],
        clusterBkg: DARK[850],
        clusterBorder: DARK[500],
        edgeLabelBackground: DARK[850],
        noteBkgColor: DARK[600],
        noteTextColor: DARK[50],
        noteBorderColor: DARK[400],
        actorBkg: DARK[700],
        actorBorder: DARK[400],
        actorTextColor: DARK[50],
        signalColor: DARK[200],
        signalTextColor: DARK[100],
        labelBoxBkgColor: DARK[700],
        labelBoxBorderColor: DARK[400],
        labelTextColor: DARK[50],
        errorBkgColor: DARK[600],
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
