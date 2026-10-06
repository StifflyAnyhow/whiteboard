import type { ReviewDeleteConfirmationProps, ReviewDeleteListedBoard } from "../common/reviewProtocol.js";

/** The boards the confirmation names: those linking to the board, and its
 * children, which move to top level. */
export type ReviewDeleteNamed = Pick<ReviewDeleteConfirmationProps, "linkedFrom" | "movesUp">;

/** Shows the confirmation and settles with the reader's answer. */
export type ReviewDeleteAsk = (title: string, named: ReviewDeleteNamed, trash?: boolean, count?: number) => Promise<boolean>;

export type { ReviewDeleteListedBoard };

export async function confirmReviewDeletion(
  ask: ReviewDeleteAsk,
  title: string,
  isCurrent: () => boolean,
  named: ReviewDeleteNamed = { linkedFrom: [] },
  trash = false,
  count = 1,
): Promise<boolean> {
  // Trash is undone in a click: ask only when other boards need this one.
  if (trash && !named.linkedFrom.length && !named.movesUp?.length) return isCurrent();
  const confirmed = await ask(title, named, trash, count);
  return confirmed && isCurrent();
}

/**
 * Mounts the canvas bundle's delete dialog in the workbench, over
 * everything, and settles once it is answered.
 */
export function askInDialog(
  mount: (container: HTMLElement, props: ReviewDeleteConfirmationProps) => { dispose(): void },
  parent: HTMLElement,
): ReviewDeleteAsk {
  return (title, named, trash, count) => new Promise<boolean>((resolve) => {
    const container = parent.ownerDocument.createElement("div");
    container.className = "review-delete-confirmation";
    parent.appendChild(container);
    const mounted = mount(container, {
      title,
      ...named,
      trash,
      ...(count !== undefined && count > 1 && { count }),
      onAnswer: (confirmed) => {
        mounted.dispose();
        container.remove();
        resolve(confirmed);
      },
    });
  });
}
