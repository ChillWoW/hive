import { invoke } from "@tauri-apps/api/core";
import type { HarnessId, UsageQuery, UsageReport, UsageRow } from "@/proto";
import { isTauri } from "@/lib/platform";

/**
 * Transport for the Usage panel (`src-tauri/src/usage.rs`). Under a plain
 * `bun run dev` there's no backend: a made-up report, so the panel renders.
 */
export const usageApi = {
    report: (query: UsageQuery): Promise<UsageReport> =>
        isTauri ? invoke("usage_report", { query }) : Promise.resolve(browserReport(query))
};

const FAKE_MODELS: [HarnessId, string, number, number][] = [
    // harness, model, $ per M processed tokens, share of traffic
    ["claude-code", "claude-opus-5-5", 0.42, 0.62],
    ["claude-code", "claude-haiku-5-5", 0.05, 0.08],
    ["codex", "gpt-6-sol", 0.3, 0.2],
    ["opencode", "openrouter/deepseek/deepseek-v4.1-flash-1017", 0.012, 0.1]
];

function browserReport(query: UsageQuery): UsageReport {
    const rows: UsageRow[] = [];
    query.buckets.forEach((start, bucket) => {
        // Quieter weekends and nights, deterministic per bucket.
        const date = new Date(start);
        const wave = 0.55 + 0.45 * Math.sin(start / 3.7e7) ** 2;
        const weekend = date.getDay() === 0 || date.getDay() === 6 ? 0.35 : 1;
        for (const [harness, model, rate, share] of FAKE_MODELS) {
            const seed = Math.abs(Math.sin(start / 1e6 + share * 99));
            if (seed < 0.18) continue;
            const total = Math.round(40e6 * share * wave * weekend * (0.5 + seed));
            const cacheRead = Math.round(total * 0.86);
            const cacheWrite = harness === "claude-code" ? Math.round(total * 0.06) : 0;
            const output = Math.round(total * 0.015);
            const input = total - cacheRead - cacheWrite - output;
            const cost = (total / 1e6) * rate;
            rows.push({
                bucket,
                harness,
                model,
                tokens: { input, cacheRead, cacheWrite, output, reasoning: Math.round(output * 0.3) },
                cost: {
                    input: cost * 0.12,
                    cacheRead: cost * 0.38,
                    cacheWrite: cost * 0.2,
                    output: cost * 0.3,
                    other: 0,
                    savings: cost * 2.6,
                    fastPremium: 0
                },
                requests: Math.round(total / 90_000),
                unpriced: 0
            });
        }
    });
    const sessions = Math.max(3, Math.round(query.buckets.length * 4.2));
    return {
        rows,
        models: FAKE_MODELS.map(([harness, model, , share]) => ({
            harness,
            model,
            sessions: Math.max(1, Math.round(sessions * share))
        })),
        harnesses: [
            { harness: "claude-code", sessions: Math.round(sessions * 0.66) },
            { harness: "codex", sessions: Math.round(sessions * 0.2) },
            { harness: "opencode", sessions: Math.round(sessions * 0.14) }
        ],
        projects: [
            ["~/dev/hive", 0.46],
            ["~/dev/zeron", 0.31],
            ["~/Desktop/pixelwrench", 0.15],
            ["~/dev/dotfiles", 0.08]
        ].map(([path, share]) => ({
            path: path as string,
            harnesses: [
                {
                    harness: "claude-code" as const,
                    tokens: Math.round(9e8 * (share as number)),
                    cost: 380 * (share as number),
                    sessions: Math.round(sessions * 0.6 * (share as number)) + 1,
                    requests: Math.round(9000 * (share as number))
                }
            ]
        })),
        sessions,
        sources: [
            { harness: "claude-code", status: "ok", path: "~/.claude/projects", files: 412 },
            { harness: "codex", status: "ok", path: "~/.codex/sessions", files: 23 },
            { harness: "opencode", status: "ok", path: "~/.local/share/opencode", files: 1 }
        ],
        pricing: { status: "fresh", fetchedAt: Date.now() - 3_600_000, models: 4831 },
        readAt: Date.now(),
        scanMs: 42
    };
}
