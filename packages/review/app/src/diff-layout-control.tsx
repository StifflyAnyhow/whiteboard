import { IconButton } from "@canvas/ui/button";
import type {
  ReviewDiffLayout,
  ReviewDiffLayoutScope,
} from "@dev.fast/review-protocol";
import * as stylex from "@stylexjs/stylex";
import {
  type ReactElement,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";

import { controlStyles } from "./controls-styles";
import { useCanvasMenu } from "./host/canvas-ui";
import { useReviewSession } from "./host/review-session";
import { SlidersIcon } from "./icons";
import { shellStyles } from "./shell-styles";
import { captureClientError, captureUiEvent } from "./ui-telemetry";
import { useTooltip } from "./use-tooltip";

const MENU_OPTIONS: ReadonlyArray<{
  scope: ReviewDiffLayoutScope;
  layout: ReviewDiffLayout;
  label: string;
}> = [
  { scope: "diff", layout: "unified", label: "Diff: Unified" },
  { scope: "diff", layout: "split", label: "Diff: Split" },
  { scope: "peek", layout: "unified", label: "Code peeks: Unified" },
  { scope: "peek", layout: "split", label: "Code peeks: Split" },
];

export function DiffLayoutControl(): ReactElement {
  const tooltip = useTooltip("Diff settings");

  const layouts = {
    diff: useDiffLayout("diff"),
    peek: useDiffLayout("peek"),
  };

  const menu = useCanvasMenu({
    items: MENU_OPTIONS.map((option) => ({
      id: `${option.scope}:${option.layout}`,
      label: option.label,
      checked: layouts[option.scope].layout === option.layout,
    })),
    onSelect: (id) => {
      const option = MENU_OPTIONS.find(
        (candidate) => `${candidate.scope}:${candidate.layout}` === id,
      );

      if (option) layouts[option.scope].choose(option.layout);
    },
  });

  return (
    <div {...stylex.props(shellStyles.topbarItem, styles.settings)}>
      <IconButton
        aria-label="Diff settings"
        ref={tooltip}
        {...menu.triggerProps}
      >
        <SlidersIcon xstyle={controlStyles.chromeIcon} />
      </IconButton>
    </div>
  );
}

const styles = stylex.create({
  settings: {
    position: "relative",
  },
});

function useDiffLayout(scope: ReviewDiffLayoutScope) {
  const session = useReviewSession();
  const bridge = session.bridge;

  const layout = useSyncExternalStore(
    useCallback(
      (onChange: () => void) => {
        const subscription = bridge.onDidChangeDiffLayout(scope, onChange);

        return () => subscription.dispose();
      },
      [bridge, scope],
    ),
    () => bridge.currentDiffLayout(scope),
  );

  // The desktop confirms a write by round-tripping the setting through its
  // change event. The choice shows at once and holds until that confirmation,
  // or drops back if the write fails.
  const [pending, setPending] = useState<ReviewDiffLayout | null>(null);
  const shownLayout = pending ?? layout;

  useEffect(() => {
    if (pending !== null && layout === pending) setPending(null);
  }, [layout, pending]);

  const choose = (next: ReviewDiffLayout) => {
    if (next === shownLayout) return;
    captureUiEvent(session, "diff_layout_changed", { layout: next, scope });
    setPending(next);
    bridge.setDiffLayout(scope, next).catch((error: Error) => {
      setPending(null);
      captureClientError(session, "settings", error, {
        component: "diff_layout",
      });
    });
  };

  return { layout: shownLayout, choose };
}
