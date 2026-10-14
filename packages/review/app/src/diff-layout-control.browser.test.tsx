import type {
  ReviewDiffLayout,
  ReviewDiffLayoutScope,
} from "@dev.fast/review-protocol";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { testCanvasUi } from "./canvas-ui-test-utils";
import { DiffLayoutControl } from "./diff-layout-control";
import { CanvasUiContext } from "./host/canvas-ui";
import { ReviewSessionProvider } from "./host/review-session";
import { testReviewSession } from "./review-session-test-utils";

describe("DiffLayoutControl", () => {
  let host: ReturnType<typeof testCanvasUi>;
  let container: HTMLDivElement;
  let root: Root;
  let layouts: Record<ReviewDiffLayoutScope, ReviewDiffLayout>;

  let listeners: Set<{
    scope: ReviewDiffLayoutScope;
    listener: (layout: ReviewDiffLayout) => void;
  }>;

  let setDiffLayout: ReturnType<
    typeof vi.fn<
      (scope: ReviewDiffLayoutScope, next: ReviewDiffLayout) => Promise<void>
    >
  >;

  let posted: unknown[];
  let session: ReturnType<typeof testReviewSession>;

  beforeEach(async () => {
    host = testCanvasUi();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    layouts = { diff: "split", peek: "unified" };
    listeners = new Set();
    posted = [];
    // The desktop writes the setting and reports back through the change
    // event, so the fake applies the write the same way.
    setDiffLayout = vi.fn<
      (scope: ReviewDiffLayoutScope, next: ReviewDiffLayout) => Promise<void>
    >(async (scope, next) => {
      confirm(scope, next);
    });

    session = testReviewSession(
      {},
      {
        currentDiffLayout: (scope) => layouts[scope],
        setDiffLayout: (scope, next) => setDiffLayout(scope, next),
        onDidChangeDiffLayout: (scope, listener) => {
          const entry = { scope, listener };
          listeners.add(entry);

          return { dispose: () => listeners.delete(entry) };
        },
        request: async (url, init) => {
          if (url.includes("/telemetry/event"))
            posted.push(JSON.parse(String(init?.body)));

          return Response.json({ ok: true });
        },
      },
    );

    await act(async () => {
      root.render(
        <CanvasUiContext.Provider value={host.ui}>
          <ReviewSessionProvider session={session}>
            <DiffLayoutControl />
          </ReviewSessionProvider>
        </CanvasUiContext.Provider>,
      );
    });
  });

  function confirm(scope: ReviewDiffLayoutScope, next: ReviewDiffLayout) {
    layouts[scope] = next;

    for (const entry of listeners)
      if (entry.scope === scope) entry.listener(next);
  }

  function checked() {
    return host.menu.items
      .filter((item) => item.checked)
      .map((item) => item.id);
  }

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("writes the chosen layout and does not rewrite the current one", async () => {
    await act(async () => trigger().click());
    await act(async () => host.select("diff:split"));
    expect(setDiffLayout).not.toHaveBeenCalled();
    await act(async () => trigger().click());
    await act(async () => host.select("diff:unified"));
    expect(setDiffLayout).toHaveBeenCalledExactlyOnceWith("diff", "unified");
    await act(async () => trigger().click());
    expect(checked()).toEqual(["diff:unified", "peek:unified"]);
  });

  it("sets the code peek layout apart from the diff layout", async () => {
    await act(async () => trigger().click());
    expect(checked()).toEqual(["diff:split", "peek:unified"]);
    await act(async () => host.select("peek:split"));
    expect(setDiffLayout).toHaveBeenCalledExactlyOnceWith("peek", "split");
    await act(async () => trigger().click());
    expect(checked()).toEqual(["diff:split", "peek:split"]);
  });

  it("preserves optimistic state, rollback and external setting updates", async () => {
    const write = Promise.withResolvers<void>();
    setDiffLayout.mockImplementation(() => write.promise);
    await act(async () => trigger().click());
    expect(checked()).toContain("diff:split");
    await act(async () => host.select("diff:unified"));
    expect(setDiffLayout).toHaveBeenCalledExactlyOnceWith("diff", "unified");
    await act(async () => trigger().click());
    expect(checked()).toContain("diff:unified");
    expect(layouts.diff).toBe("split");
    await act(async () => {
      host.menu.onHide();
      write.reject(new Error("Read-only settings"));
    });
    await act(async () => trigger().click());
    expect(checked()).toContain("diff:split");
    expect(posted).toContainEqual(
      expect.objectContaining({
        name: "client_error",
        properties: expect.objectContaining({
          error_source: "settings",
          component: "diff_layout",
        }),
      }),
    );
    await act(async () => {
      host.menu.onHide();
      confirm("diff", "unified");
    });
    await act(async () => trigger().click());
    expect(checked()).toContain("diff:unified");
  });

  function trigger() {
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Diff settings"]',
    );

    if (!button) throw new Error("Diff settings button not found");

    return button;
  }
});
