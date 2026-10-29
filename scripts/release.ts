/**
 * Bumps Hive's version, commits it and tags it, ready to push:
 *
 *   bun run release 0.0.2
 *   git push --follow-tags
 *
 * The pushed `v*` tag starts `.github/workflows/release.yml`, which builds the
 * installer and publishes the GitHub release the updater reads.
 *
 * The version lives in package.json, src-tauri/tauri.conf.json (what the app
 * reports and the updater compares) and src-tauri/Cargo.toml; Cargo.lock
 * follows. Refuses a dirty tree, so the release commit holds only the bump.
 */
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function run([cmd, ...args]: string[], quiet = false): string {
    const out = execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (!quiet && out.trim()) console.log(out.trim());
    return out;
}

/** Replaces the first `pattern` match in `file`, failing when there's none. */
async function bump(file: string, pattern: RegExp, version: string) {
    const path = join(root, file);
    const text = await readFile(path, "utf8");
    if (!pattern.test(text)) throw new Error(`No version found in ${file}.`);
    await writeFile(
        path,
        text.replace(pattern, (_: string, before: string, after: string) => `${before}${version}${after}`)
    );
}

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !SEMVER.test(version)) {
    console.error("Usage: bun run release <version>   (e.g. 0.0.2)");
    process.exit(1);
}
const current = JSON.parse(await readFile(join(root, "src-tauri/tauri.conf.json"), "utf8")).version;
if (version === current) {
    console.error(`Hive is already at ${version}.`);
    process.exit(1);
}
if (run(["git", "status", "--porcelain"], true).trim()) {
    console.error("Commit or stash your changes first.");
    process.exit(1);
}
if (run(["git", "tag", "--list", `v${version}`], true).trim()) {
    console.error(`Tag v${version} already exists.`);
    process.exit(1);
}

const JSON_VERSION = /^(\s*"version":\s*")[^"]*(")/m;
await bump("package.json", JSON_VERSION, version);
await bump("src-tauri/tauri.conf.json", JSON_VERSION, version);
await bump("src-tauri/Cargo.toml", /^(version = ")[^"]*(")/m, version);
// Writes the new version into Cargo.lock.
run(["cargo", "metadata", "--format-version", "1", "--offline"], true);

run(["git", "add", "package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "Cargo.lock"]);
run(["git", "commit", "-q", "-m", `chore: release v${version}`]);
run(["git", "tag", "-a", `v${version}`, "-m", `v${version}`]);
console.log(`${current} → ${version}, tagged v${version}. Push it with:\n\n  git push --follow-tags`);
