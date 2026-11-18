import { useEffect, type RefObject } from "react";

export function useDismissOutside(container: RefObject<HTMLElement | null>, dismiss: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;

    // Safari can blur the input before an in-panel tap dispatches click, without a new focus target.
    function handleOutside(event: Event) {
      if (event.target instanceof Node && !container.current?.contains(event.target)) dismiss();
    }

    document.addEventListener("pointerdown", handleOutside, true);
    document.addEventListener("focusin", handleOutside, true);
    return () => {
      document.removeEventListener("pointerdown", handleOutside, true);
      document.removeEventListener("focusin", handleOutside, true);
    };
  }, [container, dismiss, enabled]);
}
