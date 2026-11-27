import { LanguageDescription, type LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { baseName } from "@/lib/paths";

/** `path`'s language by its file name (loaded on first use), or null when it's unknown. */
export async function languageOf(path: string): Promise<LanguageSupport | null> {
    const description = LanguageDescription.matchFilename(languages, baseName(path));
    if (!description) return null;
    return description.support ?? (await description.load());
}
