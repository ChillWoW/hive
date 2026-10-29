import type {
    HarnessId,
    UsageCost,
    UsageQuery,
    UsageReport,
    UsageTokens
} from "@/proto";

/** Chart and legend order, and each harness's fixed colour (validated as a
 * set against the dark surface; follows the harness, never its rank). */
export const HARNESS_ORDER: HarnessId[] = ["claude-code", "codex", "opencode", "mock"];
export const HARNESS_COLOR: Record<HarnessId, string> = {
    "claude-code": "#d95926",
    codex: "#3987e5",
    opencode: "#199e70",
    mock: "#9085e9"
};
export const HARNESS_NAME: Record<HarnessId, string> = {
    "claude-code": "Claude Code",
    codex: "Codex",
    opencode: "OpenCode",
    mock: "Mock"
};

const ZERO_TOKENS: UsageTokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
const ZERO_COST: UsageCost = {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    other: 0,
    savings: 0,
    fastPremium: 0
};

export const processed = (t: UsageTokens) => t.input + t.cacheRead + t.cacheWrite + t.output;
export const costTotal = (c: UsageCost) =>
    c.input + c.cacheRead + c.cacheWrite + c.output + c.other;

function addTokens(a: UsageTokens, b: UsageTokens) {
    a.input += b.input;
    a.cacheRead += b.cacheRead;
    a.cacheWrite += b.cacheWrite;
    a.output += b.output;
    a.reasoning += b.reasoning;
}

function addCost(a: UsageCost, b: UsageCost) {
    a.input += b.input;
    a.cacheRead += b.cacheRead;
    a.cacheWrite += b.cacheWrite;
    a.output += b.output;
    a.other += b.other;
    a.savings += b.savings;
    a.fastPremium += b.fastPremium;
}

export type Totals = {
    tokens: UsageTokens;
    cost: UsageCost;
    requests: number;
    unpriced: number;
    sessions: number;
};

function add(t: Totals, row: UsageReport["rows"][number]) {
    addTokens(t.tokens, row.tokens);
    addCost(t.cost, row.cost);
    t.requests += row.requests;
    t.unpriced += row.unpriced;
}

const totals = (): Totals => ({
    tokens: { ...ZERO_TOKENS },
    cost: { ...ZERO_COST },
    requests: 0,
    unpriced: 0,
    sessions: 0
});

export type HarnessTotals = Totals & { harness: HarnessId };
export type ModelTotals = Totals & { harness: HarnessId; model: string };
export type BucketTotals = {
    start: number;
    end: number;
    cost: number;
    tokens: number;
    by: Partial<Record<HarnessId, { cost: number; tokens: number }>>;
};
export type ProjectTotals = {
    path: string;
    cost: number;
    tokens: number;
    sessions: number;
    requests: number;
    harnesses: HarnessId[];
};

export type Summary = {
    all: Totals;
    /** Every harness with usage, shown or not, in fixed order. */
    harnesses: HarnessTotals[];
    models: ModelTotals[];
    buckets: BucketTotals[];
    projects: ProjectTotals[];
};

/** The report with the hidden harnesses left out. */
export function summarize(
    report: UsageReport,
    query: UsageQuery,
    hidden: HarnessId[]
): Summary {
    const shown = (h: HarnessId) => !hidden.includes(h);
    const all = totals();
    const harnesses = new Map<HarnessId, HarnessTotals>();
    const models = new Map<string, ModelTotals>();
    const buckets: BucketTotals[] = query.buckets.map((start, i) => ({
        start,
        end: query.buckets[i + 1] ?? query.until,
        cost: 0,
        tokens: 0,
        by: {}
    }));

    for (const row of report.rows) {
        let h = harnesses.get(row.harness);
        if (!h) harnesses.set(row.harness, (h = { ...totals(), harness: row.harness }));
        add(h, row);
        if (!shown(row.harness)) continue;

        const key = `${row.harness}\u0000${row.model}`;
        let m = models.get(key);
        if (!m) models.set(key, (m = { ...totals(), harness: row.harness, model: row.model }));
        add(all, row);
        add(m, row);
        const bucket = buckets[row.bucket];
        if (bucket) {
            const cost = costTotal(row.cost);
            const tokens = processed(row.tokens);
            bucket.cost += cost;
            bucket.tokens += tokens;
            const by = (bucket.by[row.harness] ??= { cost: 0, tokens: 0 });
            by.cost += cost;
            by.tokens += tokens;
        }
    }

    for (const h of report.harnesses) {
        const t = harnesses.get(h.harness);
        if (t) t.sessions = h.sessions;
        if (shown(h.harness)) all.sessions += h.sessions;
    }
    for (const m of report.models) {
        const t = models.get(`${m.harness}\u0000${m.model}`);
        if (t) t.sessions = m.sessions;
    }

    const projects: ProjectTotals[] = [];
    for (const p of report.projects) {
        const parts = p.harnesses.filter((h) => shown(h.harness));
        if (!parts.length) continue;
        projects.push({
            path: p.path,
            cost: parts.reduce((s, h) => s + h.cost, 0),
            tokens: parts.reduce((s, h) => s + h.tokens, 0),
            sessions: parts.reduce((s, h) => s + h.sessions, 0),
            requests: parts.reduce((s, h) => s + h.requests, 0),
            harnesses: parts.map((h) => h.harness)
        });
    }

    return {
        all,
        harnesses: HARNESS_ORDER.flatMap((id) => {
            const h = harnesses.get(id);
            return h ? [h] : [];
        }),
        models: [...models.values()],
        buckets,
        projects
    };
}

/** Of a metric, by its job: dollars or processed tokens. */
export const valueOf = (t: Totals, metric: "cost" | "tokens") =>
    metric === "cost" ? costTotal(t.cost) : processed(t.tokens);
