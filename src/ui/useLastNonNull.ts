import { useEffect, useState } from "react";

/**
 * `value`, or the last non-null one while it's null: a dialog driven by a
 * nullable subject keeps showing it while it animates out.
 */
export function useLastNonNull<T>(value: T | null): T | null {
    const [last, setLast] = useState(value);
    useEffect(() => {
        if (value !== null) setLast(value);
    }, [value]);
    return value ?? last;
}
