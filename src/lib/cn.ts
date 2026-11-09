import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

/** Base UI parts take `className` as a string or as a function of their state. Merges the kit's
 *  own classes into either form, so a wrapper keeps the function form working for callers. */
export function mergeClassName<State>(
    base: ClassValue,
    className: string | ((state: State) => string | undefined) | undefined
): string | ((state: State) => string) {
    return typeof className === "function"
        ? (state) => cn(base, className(state))
        : cn(base, className);
}
