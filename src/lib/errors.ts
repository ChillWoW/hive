/** A caught value as text: an `Error`'s message, a string as is, else `fallback` (or the value stringified). */
export function errorMessage(error: unknown, fallback?: string): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    return fallback ?? String(error);
}
