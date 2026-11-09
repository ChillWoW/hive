import { useEffect, useState } from "react";

/** State that goes back to `initial` `ms` after it's set to anything else. */
export function useAutoReset<T>(initial: T, ms: number) {
    const [value, setValue] = useState(initial);
    useEffect(() => {
        if (value === initial) return;
        const timer = setTimeout(() => setValue(initial), ms);
        return () => clearTimeout(timer);
    }, [value, initial, ms]);
    return [value, setValue] as const;
}

/**
 * A two-step button: the first press arms it, a second within a few seconds
 * runs `onConfirm`; leaving it disarms.
 */
export function useConfirmPress(onConfirm: () => void) {
    const [armed, setArmed] = useAutoReset(false, 4000);
    return {
        armed,
        onClick: () => {
            if (!armed) return setArmed(true);
            setArmed(false);
            onConfirm();
        },
        onBlur: () => setArmed(false)
    };
}
