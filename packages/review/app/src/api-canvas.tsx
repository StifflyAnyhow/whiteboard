import { fontSize } from "@canvas/scale.stylex";
import {
  type ReviewCanvasContent,
  type ReviewDocumentWidthChoice,
  boardTitle,
  parseReviewBoardPlace,
  resolveReviewSourceView,
} from "@dev.fast/review-protocol";
import type { ActivitySnapshot } from "@review/review-api/activity";
import { ReviewApiClient, ReviewApiError } from "@review/review-api/client";
import { elements } from "@review/review-api/document";
import type { Snapshot } from "@review/review-api/store";
import * as stylex from "@stylexjs/stylex";
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  ApiDocument,
  type ApiDocumentData,
  createDocumentLoader,
  documentHasTitle,
} from "./api-document";
import { retainedTrace } from "./api-trace";
import { App } from "./App";
import type { RenderedReviewDocument } from "./App";
import {
  AskBoardTitleContext,
  AskProjectContext,
  readOpenAsks,
} from "./ask-open-state";
import { AuthoringActivityContext } from "./authoring-activity-context";
import {
  type AuthoringCursor,
  type CursorMemory,
  nextCursor,
} from "./authoring-cursor";
import { SaveMarkdown } from "./blocks";
import { BoardCommitsContext } from "./board-commits";
import {
  BoardEditor,
  type BoardEditorHost,
  BoardEditorHostContext,
} from "./board-editor/BoardEditor";
import { CanvasQueryProvider } from "./canvas-query";
import { DisplayedReviewVersionContext } from "./displayed-review-version-context";
import { DrawQueueProvider } from "./draw-queue-provider";
import { CanvasUiContext } from "./host/canvas-ui";
import {
  ReviewSessionProvider,
  createReviewSession,
  useReviewSession,
} from "./host/review-session";
import { ReviewDocumentBoundary } from "./review-document-boundary";
import { reportReviewDocumentRenderError } from "./review-document-error-report";
import type { ReviewTocEntry } from "./review-document-headings";
import type { ReviewFindHost } from "./review-find";
import { ReviewLensesProvider } from "./review-lenses";
import { ReviewPanelProvider } from "./review-panel";
import { readReviewNavigationRestore } from "./review-view-state";
import { SharingContext } from "./share-control";
import { tokens } from "./tokens.stylex";
import { TutorialProvider } from "./tutorial-context";
import { Button } from "./ui/button";

type ApiContent = Extract<ReviewCanvasContent, { kind: "api" }>;

const DocumentData = createContext<ApiDocumentData | null>(null);

const MapEnabled = createContext(false);

// A stable component type keeps sections, diagram tours and selections mounted.
function DocumentBody() {
  const data = useContext(DocumentData)!;
  const session = useReviewSession();
  const softwareMapEnabled = useContext(MapEnabled);
  const editing = useContext(BoardEditorHostContext) !== null;

  // App keys its boundary on the review id; this one recovers on the next version.
  return (
    <ReviewDocumentBoundary
      session={session}
      revision={`${data.snapshot.reviewId}:${data.snapshot.version}:${data.snapshot.pins?.worktreeRevision ?? ""}`}
      onError={(_revision, error) =>
        reportReviewDocumentRenderError(session, error)
      }
    >
      {editing ? (
        <BoardEditor data={data} softwareMapEnabled={softwareMapEnabled} />
      ) : (
        <ApiDocument data={data} softwareMapEnabled={softwareMapEnabled} />
      )}
    </ReviewDocumentBoundary>
  );
}

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

export function ApiCanvas({
  content,
  findHost,
}: {
  content: ApiContent;
  findHost?: ReviewFindHost;
}) {
  const client = useMemo(
    () => new ReviewApiClient(content.bridge.config, content.bridge.request),
    [content.bridge],
  );

  const [version, setVersion] = useState(content.version);
  const [coverageRevision, setCoverageRevision] = useState(0);
  // Bumped when the board's parent or siblings change, so its header
  // reads them again.
  const [placeRevision, setPlaceRevision] = useState(0);
  const [activity, setActivity] = useState<ActivitySnapshot | "unknown">();
  const [cursor, setCursor] = useState<AuthoringCursor | null>(null);
  const [lensCursor, setLensCursor] = useState<AuthoringCursor | null>(null);
  useEffect(() => setVersion(content.version), [content.version]);
  const [data, setData] = useState<ApiDocumentData>();
  const [trashedAt, setTrashedAt] = useState<string | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const sourceRef = useRef<{ key: string; version: number }>(undefined);
  const sourceVersion = sourceRef.current?.key;
  const [error, setError] = useState<string>();
  useEffect(() => {
    const abort = new AbortController();
    const loader = createDocumentLoader(client);
    setData(undefined);
    setTrashedAt(null);
    setActivity(undefined);
    setCursor(null);
    setLensCursor(null);
    // One stream, two couriers: each scope folds its own edits and focus.
    const cursorMemory: CursorMemory = {};
    const lensMemory: CursorMemory = {};

    const show = async (snapshot: Snapshot) => {
      setTrashedAt(snapshot.trashedAt ?? null);
      const next = await loader.load(snapshot);

      if (abort.signal.aborted) return;

      // Native source widgets must use these pins on their first mount.
      const key = JSON.stringify([
        snapshot.reviewId,
        snapshot.pins,
        version === undefined ? "current" : version,
      ]);

      if (sourceRef.current?.key !== key)
        sourceRef.current = { key, version: snapshot.version };

      content.setSourceView?.(
        version === undefined
          ? { reviewId: snapshot.reviewId, kind: "current" }
          : { reviewId: snapshot.reviewId, kind: "version", version },
        resolveReviewSourceView({
          ...snapshot,
          version: sourceRef.current.version,
        }),
      );
      setData(next);
      setError(undefined);
      content.setTitle?.(boardTitle(snapshot.title));
    };

    void (async () => {
      if (version !== undefined) {
        try {
          await show(
            await client.read(
              `/${content.reviewId}?full=true&version=${version}`,
              abort.signal,
            ),
          );
        } catch (cause) {
          if (!abort.signal.aborted) setError(message(cause));
        }
      }

      let shownVersion: string | undefined;
      let shownLinks = 0;
      await client.follow<
        Snapshot & {
          activity: ActivitySnapshot;
          coverageRevision?: number;
          linksRevision?: number;
          placeRevision?: number;
        }
      >(
        content.reviewId,
        abort.signal,
        async (snapshot) => {
          setActivity(snapshot.activity);
          setCursor((current) => nextCursor(current, cursorMemory, snapshot));
          setLensCursor((current) =>
            nextCursor(current, lensMemory, snapshot, "lenses"),
          );
          setCoverageRevision(snapshot.coverageRevision ?? 0);
          setPlaceRevision(snapshot.placeRevision ?? 0);

          if (version !== undefined) return;

          const shown = `${snapshot.version}:${snapshot.pins?.worktreeRevision ?? ""}:${snapshot.sourceUnavailable ?? false}:${snapshot.trashedAt ?? ""}`;
          const links = snapshot.linksRevision ?? 0;

          if (shownVersion === shown) {
            setError(undefined);

            // A board it links to changed: only its links' targets load again.
            if (links !== shownLinks && dataRef.current) {
              shownLinks = links;
              const next = await loader.relink(dataRef.current);

              if (!abort.signal.aborted) setData(next);
            }

            return;
          }

          try {
            await show(snapshot);
            shownVersion = shown;
            shownLinks = links;
          } catch (cause) {
            // A failed resource or source fetch is a document problem. The
            // stream and the activity signal are still healthy, so do not
            // reconnect or report unknown activity.
            if (!abort.signal.aborted) setError(message(cause));
          }
        },
        (cause) => {
          setActivity("unknown");
          setCursor((current) =>
            current
              ? nextCursor(current, cursorMemory, {
                  version: cursorMemory.version ?? 0,
                  activity: "unknown",
                })
              : current,
          );

          setLensCursor((current) =>
            current
              ? nextCursor(
                  current,
                  lensMemory,
                  {
                    version: lensMemory.version ?? 0,
                    activity: "unknown",
                  },
                  "lenses",
                )
              : current,
          );

          if (
            cause instanceof ReviewApiError &&
            [401, 403, 404].includes(cause.status)
          ) {
            setError(cause.message);

            return;
          }

          setError(
            `Connection lost. Reconnecting… ${cause instanceof Error ? cause.message : ""}`,
          );
        },
      );
    })();

    return () => {
      abort.abort();
      loader.dispose();
    };
  }, [client, content.reviewId, version]);

  const nativeSources = useMemo(
    () => ({
      inlineEditors: { ...content.bridge.inlineEditors },
      diffView: { ...content.bridge.diffView },
    }),
    [content.bridge, sourceVersion, content.structuralDiffEnabled],
  );

  const baseSession = useMemo(() => {
    const bridge = {
      ...content.bridge,
      ...nativeSources,
      post: async (request: Parameters<ApiContent["bridge"]["post"]>[0]) => {
        if (request.name === "openReviewRevision") {
          setVersion(
            request.args.revision === undefined
              ? undefined
              : Number(request.args.revision),
          );

          return { ok: true as const };
        }

        return content.bridge.post(request);
      },
    };

    const session = createReviewSession(bridge, {
      jsonReview: {
        id: content.reviewId,
        version: () => dataRef.current?.snapshot.version,
      },
    });

    session.softwareMapData = (model) =>
      [...(dataRef.current?.maps.values() ?? [])].find((map) => map === model)
        ?.pinnedData;

    return session;
  }, [content.bridge, content.reviewId, nativeSources]);

  const ui = useContext(CanvasUiContext);

  const session = useMemo(() => {
    if (!data) return baseSession;
    const snapshot = data.snapshot;

    return {
      ...baseSession,
      review: {
        trashedAt: snapshot.trashedAt,
        reviewId: snapshot.reviewId,
        pins: snapshot.pins
          ? { base: snapshot.pins.base, head: snapshot.pins.head }
          : undefined,
        targetKind: snapshot.target?.kind,
        historicalRevision: version === undefined ? null : String(version),
        updatedAtMs: Date.parse(snapshot.createdAt),
        headBranch: snapshot.origin?.branch,
        baseRef:
          snapshot.origin?.baseRef ??
          (snapshot.target && "base" in snapshot.target
            ? snapshot.target.base
            : undefined),
        headRef:
          snapshot.target?.kind === "commits"
            ? snapshot.target.head
            : undefined,
        pullRequestNumber: snapshot.origin?.pullRequestNumber,
        pullRequestUrl: snapshot.origin?.pullRequestUrl,
        traces: new Map(
          [...data.traces].map(([id, trace]) => [id, retainedTrace(id, trace)]),
        ),
        placeRevision,
        place: async (signal: AbortSignal) =>
          parseReviewBoardPlace(
            await client.read(`/${snapshot.reviewId}/place`, signal),
          ),
        dismiss: async () => {
          if (
            ui?.confirmDelete &&
            !(await ui.confirmDelete(snapshot.title, content.reviewId, true))
          )
            return false;

          await client.personCommand({
            type: "lifecycle",
            reviewId: content.reviewId,
            state: "trash",
          });

          return true;
        },
      },
    };
  }, [baseSession, client, content.reviewId, data, placeRevision, version, ui]);

  // Only the latest version of a review this machine owns takes edits.
  const editable =
    version === undefined &&
    data !== undefined &&
    !data.snapshot.shared &&
    !data.snapshot.trashedAt;

  const saveMarkdown = useMemo(
    () =>
      editable
        ? (blockId: string, markdown: string) =>
            // The person's own edit, credited to them.
            void client
              .personCommand({
                type: "edit",
                reviewId: content.reviewId,
                edit: {
                  type: "update",
                  targetId: blockId,
                  changes: { markdown },
                },
              })
              .catch((cause) => setError(message(cause)))
        : undefined,
    [client, content.reviewId, editable],
  );

  // The board editor's Contents, as the person types.
  const [editorToc, setEditorToc] = useState<ReviewTocEntry[]>();

  const editorHost = useMemo<BoardEditorHost | null>(
    () => (editable ? { client, setHeadings: setEditorToc } : null),
    [client, editable],
  );

  useEffect(() => {
    if (data) content.bridge.ready();
  }, [Boolean(data), content.bridge]);

  useEffect(() => {
    if (data) content.setTutorial?.(data.snapshot.origin?.tutorial === true);
  }, [data?.snapshot.origin?.tutorial, content.setTutorial]);

  const sharing = useMemo(
    () =>
      data && !data.snapshot.trashedAt
        ? {
            client,
            reviewId: content.reviewId,
            version: data.snapshot.version,
            sender: data.snapshot.shared?.login,
          }
        : null,
    [client, content.reviewId, data],
  );

  const pins = data?.snapshot.pins;

  const boardCommits = useMemo(
    () => (pins ? [pins.head, pins.base] : []),
    [pins],
  );

  const trashBanner = trashedAt && (
    <div role="status" {...stylex.props(styles.trashBanner)}>
      In Trash ·{" "}
      {Math.min(
        30,
        Math.max(
          0,
          Math.ceil(
            (Date.parse(trashedAt) + 30 * 86400000 - Date.now()) / 86400000,
          ),
        ),
      )}{" "}
      days left
      <Button
        onClick={() =>
          void client
            .personCommand({
              type: "lifecycle",
              state: "active",
              reviewId: content.reviewId,
            })
            .then(() => client.read<Snapshot>(`/${content.reviewId}?full=true`))
            .then((snapshot) => {
              setTrashedAt(snapshot.trashedAt ?? null);
              setData((current) => current && { ...current, snapshot });
            })
            .catch((cause) => setError(message(cause)))
        }
      >
        Restore
      </Button>
    </div>
  );

  // Loads are near-instant, so stay blank until there is data or an error.
  // Both branches root the same query provider, so its cache outlives a load.
  if (!data)
    return (
      <CanvasQueryProvider client={client} reviewId={content.reviewId}>
        {trashBanner}
        {error !== undefined && (
          <>
            <p {...stylex.props(styles.error)} role="status">
              {error}
            </p>
            {version !== undefined && (
              <button onClick={() => setVersion(undefined)}>
                Back to latest version
              </button>
            )}
          </>
        )}
      </CanvasQueryProvider>
    );

  const title = boardTitle(data.snapshot.title);

  return (
    <div {...stylex.props(styles.canvasSurface)}>
      <CanvasQueryProvider client={client} reviewId={content.reviewId}>
        <SharingContext.Provider value={sharing}>
          <ReviewSessionProvider session={session}>
            <AskProjectContext.Provider value={content.projectId}>
              <AskBoardTitleContext.Provider value={title}>
                <ReviewPanelProvider
                  restore={() => ({
                    asks: readOpenAsks(session.config, content.projectId),
                    ...readReviewNavigationRestore(session.config, {
                      softwareMapEnabled:
                        content.softwareMapEnabled === true &&
                        data.maps.size > 0,
                      hasChangeRange:
                        (data.snapshot.pins?.base ?? "") !==
                        (data.snapshot.pins?.head ?? ""),
                      version: data.snapshot.version,
                      lensMode:
                        content.structuralDiffEnabled === false
                          ? "textual"
                          : "structural",
                      commits: data.commits,
                    }),
                  })}
                >
                  <BoardCommitsContext.Provider value={boardCommits}>
                    <DocumentData.Provider value={data}>
                      <ReviewLensesProvider
                        client={client}
                        snapshot={data.snapshot}
                        coverageRevision={coverageRevision}
                        structuralDiffEnabled={content.structuralDiffEnabled}
                      >
                        <TutorialProvider tutorial={content.tutorial}>
                          {error && (
                            <p {...stylex.props(styles.error)} role="status">
                              {error}
                            </p>
                          )}
                          {trashBanner}
                          <AuthoringActivityContext.Provider
                            value={version === undefined ? activity : undefined}
                          >
                            <DrawQueueProvider
                              cursor={
                                version === undefined ? cursor : undefined
                              }
                            >
                              <DrawQueueProvider
                                scope="lenses"
                                cursor={
                                  version === undefined ? lensCursor : undefined
                                }
                              >
                                <DisplayedReviewVersionContext.Provider
                                  value={data.snapshot.version}
                                >
                                  <MapEnabled.Provider
                                    value={content.softwareMapEnabled === true}
                                  >
                                    <SaveMarkdown.Provider value={saveMarkdown}>
                                      <div
                                        {...stylex.props(styles.canvasFrame)}
                                      >
                                        <BoardEditorHostContext.Provider
                                          value={editorHost}
                                        >
                                          <CanvasDocument
                                            data={data}
                                            findHost={findHost}
                                            softwareMapEnabled={
                                              content.softwareMapEnabled ===
                                              true
                                            }
                                            documentWidth={
                                              content.documentWidth
                                            }
                                            tocEntries={
                                              editorHost ? editorToc : undefined
                                            }
                                          />
                                        </BoardEditorHostContext.Provider>
                                      </div>
                                    </SaveMarkdown.Provider>
                                  </MapEnabled.Provider>
                                </DisplayedReviewVersionContext.Provider>
                              </DrawQueueProvider>
                            </DrawQueueProvider>
                          </AuthoringActivityContext.Provider>
                        </TutorialProvider>
                      </ReviewLensesProvider>
                    </DocumentData.Provider>
                  </BoardCommitsContext.Provider>
                </ReviewPanelProvider>
              </AskBoardTitleContext.Provider>
            </AskProjectContext.Provider>
          </ReviewSessionProvider>
        </SharingContext.Provider>
      </CanvasQueryProvider>
    </div>
  );
}

// Activity updates only the badge; keep diagram inputs stable until document data changes.
const CanvasDocument = memo(function CanvasDocument({
  data,
  findHost,
  softwareMapEnabled,
  documentWidth,
  tocEntries,
}: {
  data: ApiDocumentData;
  findHost?: ReviewFindHost;
  softwareMapEnabled: boolean;
  documentWidth?: ReviewDocumentWidthChoice;
  /** The editor's Contents, when the board is being edited. */
  tocEntries?: ReviewTocEntry[];
}) {
  const snapshot = data.snapshot;

  const document: RenderedReviewDocument = {
    key: snapshot.reviewId,
    routePath: "/",
    filePath: `review:${snapshot.reviewId}`,
    documentSoftwareModels: [...data.maps.values()],
    anchors: data.anchors,
    render: DocumentBody,
    tocEntries: tocEntries ?? data.headings.entries,
    empty: snapshot.document.length === 0,
    header: true,
    databaseLens: elements(snapshot.document).some(
      (node) => node.type === "database_lens",
    ),
    width: documentWidth,
  };

  return (
    <App
      document={document}
      softwareMap={{
        head:
          [...data.maps.values()].find(
            (map) => map.pinnedData.side === "head",
          ) ?? null,
        base:
          [...data.maps.values()].find(
            (map) => map.pinnedData.side === "base",
          ) ?? null,
      }}
      softwareMapEnabled={softwareMapEnabled && data.maps.size > 0}
      // A document without pins of its own has no change range: the Diff and
      // Commits views hide, as for a review whose base is its head.
      range={{
        sourceUnavailable: snapshot.sourceUnavailable
          ? "Local checkout unavailable."
          : undefined,
        baseRef: snapshot.pins?.base ?? "",
        headRef: snapshot.pins?.head ?? "",
        baseCommit: snapshot.pins?.base ?? "",
        headCommit: snapshot.pins?.head ?? "",
        worktreeRevision: snapshot.pins?.worktreeRevision,
      }}
      commits={data.commits}
      findHost={findHost}
    />
  );
});

const styles = stylex.create({
  canvasSurface: {
    height: "100%",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
  },
  canvasFrame: { flex: "1 1 auto", minHeight: 0 },
  trashBanner: {
    display: "flex",
    gap: "12px",
    alignItems: "center",
    padding: "10px 24px",
    backgroundColor: tokens.tray,
    color: tokens.inkMuted,
    fontFamily: tokens.chromeFont,
    fontSize: fontSize.body,
    flexShrink: 0,
  },
  error: {
    maxWidth: "72ch",
    margin: "32px auto",
    padding: "0 24px",
    font: `${fontSize.reading}/1.6 ${tokens.chromeFont}`,
  },
});
