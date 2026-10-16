/**
 * Regenerates src-tauri/icons/{prod,dev} from the two source SVGs, and copies
 * the prod source to public/favicon.svg for the web view.
 *
 *   bun run icons
 *
 * Every platform but macOS wants the artwork full-bleed: Windows and Linux draw
 * their own frame around it, so padding the source just shrinks the icon inside
 * a box the OS already sized. macOS is the opposite — it draws nothing, and the
 * squircle in the source *is* the icon, so a full-bleed 1024 renders wider than
 * every stock app beside it in the dock.
 *
 * Apple's icon grid puts the rounded square at 824x824 inside a 1024x1024
 * canvas; the remaining 100px on each side is transparent margin, which is what
 * makes a dock line up. So the .icns is generated from a second, padded copy of
 * the same art, and only the .icns — the .ico and the PNGs stay full-bleed.
 *
 * Run this instead of `tauri icon` directly. `tauri icon` writes the whole set
 * from one source, which silently returns macOS to a full-bleed icon.
 */
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const icons = join(root, "src-tauri", "icons");

const VARIANTS = [
    { out: "prod", source: "icon.svg" },
    { out: "dev", source: "icon.dev.svg" },
];

/** Apple's app icon grid, in the units the generated 1024px icon is measured in. */
const CANVAS = 1024;
const BODY = 824;

/** Wrap a source SVG's art in the padded canvas macOS expects. */
async function macosSvg(source: string): Promise<string> {
    const svg = await readFile(source, "utf8");

    const viewBox = svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) /);
    if (!viewBox) throw new Error(`${source}: expected a viewBox starting at 0 0`);

    const art = svg
        .replace(/^[\s\S]*?<svg[^>]*>/, "")
        .replace(/<\/svg>\s*$/, "")
        .trim();

    const inset = (CANVAS - BODY) / 2;
    const scale = BODY / Number(viewBox[1]);

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" shape-rendering="geometricPrecision">`,
        `  <g transform="translate(${inset},${inset}) scale(${scale})">`,
        art
            .split("\n")
            .map((line) => `    ${line}`)
            .join("\n"),
        `  </g>`,
        `</svg>`,
        ``,
    ].join("\n");
}

async function tauriIcon(input: string, output: string): Promise<void> {
    const proc = Bun.spawn(["bunx", "tauri", "icon", input, "--output", output], {
        cwd: root,
        stdout: "inherit",
        stderr: "inherit",
    });

    if ((await proc.exited) !== 0) throw new Error(`tauri icon failed for ${input}`);
}

for (const variant of VARIANTS) {
    const source = join(icons, variant.source);
    const output = join(icons, variant.out);

    await tauriIcon(source, output);

    // `tauri icon` always writes these; there is no desktop target that reads them.
    for (const mobile of ["android", "ios"])
        await rm(join(output, mobile), { recursive: true, force: true });

    const scratch = await mkdtemp(join(tmpdir(), `hive-icon-${variant.out}-`));
    try {
        const padded = join(scratch, "icon.svg");
        await writeFile(padded, await macosSvg(source));
        await tauriIcon(padded, scratch);
        await copyFile(join(scratch, "icon.icns"), join(output, "icon.icns"));
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }

    console.log(`${variant.source} -> icons/${variant.out} (icon.icns padded for macOS)`);
}

await copyFile(join(icons, "icon.svg"), join(root, "public", "favicon.svg"));
console.log("icon.svg -> public/favicon.svg");
