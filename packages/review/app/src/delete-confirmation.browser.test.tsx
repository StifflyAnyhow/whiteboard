import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { mountDeleteConfirmation } from "./desktop-entry";

afterEach(() => document.body.replaceChildren());

const open = async (onAnswer: (confirmed: boolean) => void) => {
  const container = document.createElement("div");
  document.body.append(container);
  let handle: ReturnType<typeof mountDeleteConfirmation> | undefined;

  await act(async () => {
    handle = mountDeleteConfirmation(container, {
      title: "MCP surface cleanup",
      linkedFrom: [
        { title: "Drop session_repin", pullRequestNumber: 840 },
        { title: "Notes" },
      ],
      onAnswer,
    });
  });

  return { container, dispose: () => act(async () => handle!.dispose()) };
};

it("keeps the board unless Delete is pressed", async () => {
  const onAnswer = vi.fn<(confirmed: boolean) => void>();
  const { container, dispose } = await open(onAnswer);

  // The safe choice holds the focus; Escape answers no.
  const [cancel, remove] = container.querySelectorAll("button");

  expect(document.activeElement).toBe(cancel);
  await act(async () =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(onAnswer).toHaveBeenLastCalledWith(false);
  await act(async () => remove!.click());
  expect(onAnswer).toHaveBeenLastCalledWith(true);
  await dispose();
});

it("names the children that move to top level, in order", async () => {
  const container = document.createElement("div");

  document.body.append(container);
  let handle: ReturnType<typeof mountDeleteConfirmation> | undefined;

  await act(async () => {
    handle = mountDeleteConfirmation(container, {
      title: "PR stack",
      linkedFrom: [],
      movesUp: [
        { title: "Keep peeks to their scope" },
        { title: "Several code chunks per step" },
      ],
      onAnswer: () => {},
    });
  });

  const moving = container.querySelector(
    '[aria-label="Whiteboards that move to top level"]',
  );

  expect(
    [...moving!.querySelectorAll("li")].map((row) => row.textContent),
  ).toEqual(["Keep peeks to their scope", "Several code chunks per step"]);
  expect(
    container.querySelector('[aria-label="Linking whiteboards"]'),
  ).toBeNull();
  await act(async () => handle!.dispose());
});

it("words a move to Trash, which deletes later", async () => {
  const container = document.createElement("div");

  document.body.append(container);
  let handle: ReturnType<typeof mountDeleteConfirmation> | undefined;

  await act(async () => {
    handle = mountDeleteConfirmation(container, {
      title: "PR stack",
      linkedFrom: [{ title: "Notes" }],
      movesUp: [{ title: "Keep peeks to their scope" }],
      trash: true,
      onAnswer: () => {},
    });
  });

  expect(container.querySelector("h2")?.textContent).toBe(
    "Move “PR stack” to Trash?",
  );
  expect(container.textContent).toContain(
    "It moves to top level when it is deleted from Trash.",
  );
  expect(container.textContent).toContain(
    "Once it is deleted from Trash, their links will show as deleted.",
  );
  expect(container.querySelectorAll("button")[1]?.textContent).toBe(
    "Move to Trash",
  );
  await act(async () => handle!.dispose());
});

it("asks about several boards together, by their count", async () => {
  const container = document.createElement("div");

  document.body.append(container);
  let handle: ReturnType<typeof mountDeleteConfirmation> | undefined;

  await act(async () => {
    handle = mountDeleteConfirmation(container, {
      title: "3 whiteboards",
      count: 3,
      linkedFrom: [{ title: "Notes" }],
      trash: true,
      onAnswer: () => {},
    });
  });

  expect(container.querySelector("h2")?.textContent).toBe(
    "Move 3 whiteboards to Trash?",
  );
  expect(container.textContent).toContain(
    "Once they are deleted from Trash, their links will show as deleted.",
  );
  await act(async () => handle!.dispose());
});
