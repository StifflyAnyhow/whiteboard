import { fontSize, fontWeight, layer, radius } from "@canvas/scale.stylex";
import type { ReviewDeleteConfirmationProps } from "@dev.fast/review-protocol";
import * as stylex from "@stylexjs/stylex";
import { Fragment, type ReactElement, useEffect, useRef } from "react";

import { BoardIcon, PullRequestStateIcon } from "./board-icons";
import { tokens } from "./tokens.stylex";
import { surfaceStyles } from "./ui/surface";

/**
 * Confirms deleting a board, and lists the children that move to top level
 * and the whiteboards that link to it. Cancel takes focus, so Enter or
 * Escape keeps the board.
 */
export function DeleteConfirmation({
  title,
  linkedFrom,
  movesUp = [],
  trash = false,
  count = 1,
  onAnswer,
}: ReviewDeleteConfirmationProps): ReactElement {
  const cancel = useRef<HTMLButtonElement>(null);
  const name = title.trim() || "Untitled whiteboard";
  // Several boards are named by their count, without quotes.
  const named = count > 1 ? `${count} whiteboards` : `“${name}”`;
  const them = count > 1 ? "them" : "it";
  const deleted = count > 1 ? "they are deleted" : "it is deleted";

  useEffect(() => cancel.current?.focus(), []);

  const groups = [
    movesUp.length > 0 && {
      detail: `${movesUp.length} ${movesUp.length === 1 ? "whiteboard is" : "whiteboards are"} nested under ${them}. ${movesUp.length === 1 ? "It moves" : "They move"} to top level${trash ? ` when ${deleted} from Trash` : ""}.`,
      label: "Whiteboards that move to top level",
      boards: movesUp,
    },
    linkedFrom.length > 0 && {
      detail: `${linkedFrom.length} ${linkedFrom.length === 1 ? "whiteboard links" : "whiteboards link"} here. ${trash ? `Once ${deleted} from Trash, their` : "Their"} links will show as deleted.`,
      label: "Linking whiteboards",
      boards: linkedFrom,
    },
  ].filter((group) => group !== false);

  return (
    <div
      {...stylex.props(styles.backdrop)}
      onMouseDown={() => onAnswer(false)}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onAnswer(false);
      }}
    >
      <section
        {...stylex.props(surfaceStyles.dialog, styles.card)}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-confirmation-title"
        aria-describedby="delete-confirmation-detail"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="delete-confirmation-title" {...stylex.props(styles.title)}>
          {trash ? `Move ${named} to Trash?` : `Delete ${named}?`}
        </h2>
        {groups.length ? (
          groups.map((group, index) => (
            <Fragment key={group.label}>
              <p
                id={index === 0 ? "delete-confirmation-detail" : undefined}
                {...stylex.props(styles.detail)}
              >
                {group.detail}
              </p>
              <ul aria-label={group.label} {...stylex.props(styles.rows)}>
                {group.boards.map((board, row) => (
                  <li key={row} {...stylex.props(styles.row)}>
                    <BoardIcon icon={board.icon} />
                    <span {...stylex.props(styles.rowTitle)}>
                      {board.title.trim() || "Untitled whiteboard"}
                    </span>
                    {board.pullRequestNumber ? (
                      <PullRequestStateIcon
                        number={board.pullRequestNumber}
                        state={board.pullRequestState}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            </Fragment>
          ))
        ) : (
          <p id="delete-confirmation-detail" {...stylex.props(styles.detail)}>
            This permanently deletes{" "}
            {count > 1 ? "these whiteboards" : "the whiteboard"}. Your source
            repository is not deleted.
          </p>
        )}
        <div {...stylex.props(styles.actions)}>
          <button
            ref={cancel}
            type="button"
            {...stylex.props(styles.button, styles.cancel)}
            onClick={() => onAnswer(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            {...stylex.props(styles.button, styles.delete)}
            onClick={() => onAnswer(true)}
          >
            {trash ? "Move to Trash" : "Delete"}
          </button>
        </div>
      </section>
    </div>
  );
}

const styles = stylex.create({
  backdrop: {
    position: "fixed",
    zIndex: layer.dialog,
    inset: 0,
    display: "grid",
    placeItems: "center",
    padding: "24px",
    backgroundColor: tokens.backdrop,
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    boxSizing: "border-box",
    width: "min(368px, 100%)",
    // A board with many children or linking boards scrolls inside the
    // window, its title and buttons with it.
    maxHeight: "100%",
    overflowY: "auto",
    padding: "18px",
    // The board's surface colour, not the raised-dialog grey.
    backgroundColor: tokens.surface,
    fontFamily: tokens.chromeFont,
  },
  title: {
    margin: 0,
    color: tokens.ink,
    fontSize: fontSize.title,
    fontWeight: fontWeight.semibold,
    lineHeight: "20px",
  },
  detail: {
    margin: 0,
    color: tokens.inkMuted,
    fontSize: fontSize.ui,
    lineHeight: "20px",
  },
  rows: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    height: "26px",
  },
  rowTitle: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    color: tokens.ink,
    fontSize: fontSize.ui,
    lineHeight: "18px",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  actions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px",
    paddingTop: "4px",
  },
  button: {
    paddingBlock: "6px",
    paddingInline: "12px",
    borderRadius: radius.small,
    fontFamily: tokens.chromeFont,
    fontSize: fontSize.ui,
    lineHeight: "18px",
    cursor: "pointer",
    outline: { default: null, ":focus-visible": `1px solid ${tokens.accent}` },
    outlineOffset: { default: null, ":focus-visible": "1px" },
  },
  cancel: {
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens.rule,
    backgroundColor: {
      default: tokens.transparent,
      ":hover": tokens.well,
    },
    color: tokens.ink,
  },
  delete: {
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens.changeRemoved,
    backgroundColor: tokens.changeRemoved,
    color: tokens.onAccent,
    filter: { default: null, ":hover": "brightness(1.1)" },
  },
});
