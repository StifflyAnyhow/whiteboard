import * as stylex from "@stylexjs/stylex";
import type { ReactElement } from "react";

import { FolderIcon } from "./icons";
import { fontSize } from "./scale.stylex";
import { tokens } from "./tokens.stylex";

/** Where a row lives, at its end: a checkout's folder, else a project's
 * name. It never gives way, but stops at 96px. */
export function FolderLabel({ name }: { name: string }): ReactElement {
  return (
    <span {...stylex.props(styles.folder)} title={name}>
      <FolderIcon />
      <span {...stylex.props(styles.name)}>{name}</span>
    </span>
  );
}

const styles = stylex.create({
  folder: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: "4px",
    maxWidth: "96px",
    color: tokens.inkFaint,
    font: `${fontSize.small}/16px ${tokens.chromeFont}`,
  },
  // A folder is what a terminal would print.
  name: {
    minWidth: 0,
    overflow: "hidden",
    fontFamily: tokens.fontMono,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});
