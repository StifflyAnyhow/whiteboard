import { randomUUID } from "node:crypto";

import {
  type LocalVcsKind,
  type VcsArg,
  parseGitRemote,
  runVcs,
} from "@dev.fast/local-vcs";
import type { PullRequestState } from "@dev.fast/review-protocol";
import { errorMessage } from "@dev.fast/trace-core";
import { z } from "zod";

import { ReviewInputError } from "./document.js";

/** Runs one subprocess and resolves its stdout; rejects on failure or timeout. */
export type RunCommand = (
  file: "git" | "jj" | "gh",
  args: VcsArg[],
  options: { cwd?: string; timeoutMs: number },
) => Promise<string>;

export interface PullRequestDeps {
  run: RunCommand;
  fetch: typeof fetch;
}

/** What GitHub says about a PR; the commits are fetched separately. */
export interface PullRequestRecord {
  host: string;
  slug: string;
  number: number;
  title: string;
  baseRefName: string;
  /** GitHub's base commit, frozen at the PR's last update. */
  baseRefOid?: string;
  state?: PullRequestState;
}

const GH_TIMEOUT_MS = 20_000;

const API_TIMEOUT_MS = 15_000;

const FETCH_TIMEOUT_MS = 120_000;

const LOCAL_TIMEOUT_MS = 30_000;

export const defaultPullRequestDeps: PullRequestDeps = {
  run: async (file, args, options) => {
    try {
      return (
        await runVcs(file, args, {
          cwd: options.cwd,
          timeout: options.timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          // Never wait on ssh asking for a passphrase nobody can see.
          env: {
            ...process.env,
            GIT_SSH_COMMAND:
              process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
          },
        })
      ).stdout;
    } catch (error) {
      // SAFETY: execFile rejects with an ExecFileException carrying stderr.
      const failure = error as { killed?: boolean; stderr?: string };

      const reason = failure.killed
        ? `timed out after ${options.timeoutMs / 1000}s`
        : String(failure.stderr ?? "").trim() || errorMessage(error);

      throw new Error(`${file} ${String(args[0])}: ${reason}`);
    }
  },
  fetch: (input, init) => fetch(input, init),
};

/** Host, owner/repo and number from a canonical PR URL (validated by the command schema). */
export function pullRequestAddress(url: string) {
  const { hostname, pathname } = new URL(url);
  const [, owner, repo, , number] = pathname.split("/");

  return { host: hostname, slug: `${owner}/${repo}`, number: Number(number) };
}

const metadataSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  baseRefName: z.string().min(1),
  baseRefOid: z.string().optional(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]).optional(),
  isDraft: z.boolean().optional(),
});

/** gh's state and draft flag as one state. */
function ghState(
  state: "OPEN" | "CLOSED" | "MERGED" | undefined,
  isDraft: boolean | undefined,
): PullRequestState | undefined {
  if (state === "MERGED") return "merged";

  if (state === "CLOSED") return "closed";

  if (state === "OPEN") return isDraft ? "draft" : "open";

  return undefined;
}

/** gh first (it carries the user's auth), then, for github.com only, GitHub's
 * public REST API: Enterprise hosts require gh. */
export async function readPullRequest(
  url: string,
  deps: PullRequestDeps,
): Promise<PullRequestRecord> {
  const { host, slug, number } = pullRequestAddress(url);
  let ghFailure: string;

  try {
    const stdout = await deps.run(
      "gh",
      [
        "pr",
        "view",
        { value: String(number) },
        "--repo",
        { value: `${host}/${slug}` },
        "--json",
        "number,title,baseRefName,baseRefOid,state,isDraft",
      ],
      { timeoutMs: GH_TIMEOUT_MS },
    );

    const { state, isDraft, ...metadata } = metadataSchema.parse(
      JSON.parse(stdout),
    );

    const pullRequestState = ghState(state, isDraft);

    return {
      host,
      slug,
      ...metadata,
      ...(pullRequestState && { state: pullRequestState }),
    };
  } catch (error) {
    ghFailure = firstLine(errorMessage(error));
  }

  if (host !== "github.com")
    throw new ReviewInputError(
      `Could not read ${url}: gh failed (${ghFailure}). Run \`gh auth login --hostname ${host}\` with an account that can read the repository, then retry.`,
      409,
    );

  let response: Response;

  try {
    response = await deps.fetch(
      `https://api.github.com/repos/${slug}/pulls/${number}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      },
    );
  } catch (error) {
    throw unreadable(
      url,
      ghFailure,
      `the GitHub API is unreachable (${firstLine(errorMessage(error))})`,
    );
  }

  if (response.status === 404)
    throw new ReviewInputError(
      `${url} was not found: it does not exist, or it is private and gh is not signed in to an account that can read it (run \`gh auth status\`). gh said: ${ghFailure}`,
      404,
    );

  if (response.status === 403 || response.status === 429) {
    const reset = Number(response.headers.get("x-ratelimit-reset"));

    throw new GitHubRefusedRead(
      unreadable(
        url,
        ghFailure,
        response.headers.get("x-ratelimit-remaining") === "0" ||
          response.status === 429
          ? "the unauthenticated GitHub API rate limit is exhausted"
          : "the GitHub API refused the request",
      ).message,
      reset > 0 ? reset * 1000 : Date.now() + 15 * 60_000,
    );
  }

  if (!response.ok)
    throw unreadable(
      url,
      ghFailure,
      `the GitHub API returned HTTP ${response.status}`,
    );

  const parsed = z
    .object({
      number: z.number(),
      title: z.string(),
      base: z.object({ ref: z.string().min(1), sha: z.string() }),
      state: z.enum(["open", "closed"]).optional(),
      draft: z.boolean().optional(),
      merged_at: z.string().nullable().optional(),
    })
    .safeParse(await response.json().catch(() => undefined));

  if (!parsed.success)
    throw unreadable(url, ghFailure, "the GitHub API response was malformed");

  return {
    host,
    slug,
    number: parsed.data.number,
    title: parsed.data.title,
    baseRefName: parsed.data.base.ref,
    baseRefOid: parsed.data.base.sha,
    ...(parsed.data.state && {
      state: parsed.data.merged_at
        ? "merged"
        : parsed.data.state === "closed"
          ? "closed"
          : parsed.data.draft
            ? "draft"
            : "open",
    }),
  };
}

/** Remotes by the host and owner/repo their configured URL names. The
 * configured URL, not the insteadOf rewrite: a mirror still names its repo. */
export async function githubRemotes(
  gitDir: string,
  deps: PullRequestDeps,
): Promise<{ name: string; host: string; slug: string }[]> {
  const stdout = await deps
    .run(
      "git",
      [
        "--git-dir",
        gitDir,
        "config",
        "--get-regexp",
        String.raw`^remote\..*\.url$`,
      ],
      { timeoutMs: LOCAL_TIMEOUT_MS },
    )
    .catch(() => "");

  return stdout.split("\n").flatMap((line) => {
    const match = /^remote\.(.+)\.url\s+(\S+)/.exec(line.trim());
    const remote = match && parseGitRemote(match[2]!);

    return match && remote
      ? [{ name: match[1]!, host: remote.host, slug: remote.slug }]
      : [];
  });
}

/** Refs Review owns for one PR; the user's branches and bookmarks never move. */
export function pullRequestRefs(pr: {
  host: string;
  slug: string;
  number: number;
}) {
  // github.com keeps the host-less namespace existing checkouts already hold.
  const repository = `${pr.host === "github.com" ? "" : `${pr.host}/`}${pr.slug}`;
  const prefix = `refs/review/github/${repository.toLowerCase()}/pull/${pr.number}`;

  return {
    head: `${prefix}/head`,
    base: `${prefix}/base`,
    frozenBase: `${prefix}/frozen-base`,
  };
}

/**
 * Fetch the PR head (refs/pull/N/head, so fork PRs work) and its base branch
 * into Review's own namespace, and return the comparison GitHub shows: the
 * head, and the merge base of the head with the base branch.
 *
 * A PR merged with a merge commit is absorbed: merge-base(base branch, head)
 * is the head itself and the diff is empty. GitHub freezes the base commit
 * (baseRefOid) at the PR's last update, so its merge base with the head is
 * the fork point GitHub diffs against, and it survives base branches that are
 * force-rebuilt or deleted.
 */
export async function fetchPullRequest(
  input: {
    rootPath: string;
    gitDir: string;
    kind: LocalVcsKind;
    remote: string;
    pullRequest: PullRequestRecord;
  },
  deps: PullRequestDeps,
): Promise<{ head: string; base: string }> {
  const { pullRequest: pr } = input;

  const refs = pullRequestRefs(pr);

  const git = (args: VcsArg[], timeoutMs = LOCAL_TIMEOUT_MS) =>
    deps
      .run("git", ["--git-dir", input.gitDir, ...args], { timeoutMs })
      .then((stdout) => stdout.trim());

  const fetchRefs = (...refspecs: VcsArg[]) =>
    git(
      [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--quiet",
        { remote: input.remote },
        ...refspecs,
      ],
      FETCH_TIMEOUT_MS,
    );

  const commit = (ref: string) =>
    git(["rev-parse", "--verify", "--quiet", { rev: `${ref}^{commit}` }]).catch(
      () => undefined,
    );

  const mergeBase = (left: string, right: string) =>
    git(["merge-base", { rev: left }, { rev: right }]).catch(() => undefined);

  const frozenBase = async () => {
    if (!pr.baseRefOid) return undefined;

    if (!(await commit(pr.baseRefOid)))
      await fetchRefs({
        refspec: { from: pr.baseRefOid, to: refs.frozenBase, force: true },
      }).catch(() => undefined);

    return commit(pr.baseRefOid);
  };

  let baseTip: string | undefined;

  const pullHead: VcsArg = {
    refspec: {
      from: `refs/pull/${pr.number}/head`,
      to: refs.head,
      force: true,
    },
  };

  try {
    await fetchRefs(pullHead, {
      refspec: {
        from: `refs/heads/${pr.baseRefName}`,
        to: refs.base,
        force: true,
      },
    });
    baseTip = await commit(refs.base);
  } catch (error) {
    // The base branch may be gone; the head and the frozen base suffice.
    try {
      await fetchRefs(pullHead);
    } catch {
      throw new ReviewInputError(
        `Could not fetch PR #${pr.number} from remote "${input.remote}" (${pr.slug}). Check \`git fetch ${input.remote}\` works with your Git credentials, then retry. Git said: ${firstLine(errorMessage(error))}`,
        409,
      );
    }
  }

  const head = await commit(refs.head);

  baseTip ??= await frozenBase();

  if (!head || !baseTip)
    throw new ReviewInputError(
      `Fetched PR #${pr.number} but could not resolve its ${head ? `base branch ${pr.baseRefName}` : "head"}.`,
      409,
    );

  let base = await mergeBase(baseTip, head);

  if (!base || base === head) {
    const frozen = await frozenBase();

    if (frozen && frozen !== baseTip)
      base = (await mergeBase(frozen, head)) ?? base;
  }

  if (!base)
    throw new ReviewInputError(
      `PR #${pr.number}'s head shares no history with ${pr.baseRefName}.`,
      409,
    );

  if (input.kind === "jj")
    await indexForJj(input.rootPath, [base, head], git, deps);

  return { head, base };
}

/**
 * jj resolves only commits in its index, and `jj git import` indexes only
 * branches, remote branches and tags. Import the commits through a
 * transient tag, then drop it: the commits stay indexed (hidden, resolvable
 * by commit id) and no bookmark or tag remains.
 */
async function indexForJj(
  rootPath: string,
  commits: string[],
  git: (args: VcsArg[]) => Promise<string>,
  deps: PullRequestDeps,
) {
  const tags = commits.map(() => `refs/tags/review-index-${randomUUID()}`);

  const jjImport = () =>
    deps.run(
      "jj",
      ["-R", rootPath, "git", "import", "--ignore-working-copy", "--quiet"],
      { cwd: rootPath, timeoutMs: LOCAL_TIMEOUT_MS },
    );

  try {
    for (const [index, tag] of tags.entries())
      await git(["update-ref", { ref: tag }, { commit: commits[index]! }]);
    await jjImport();
  } finally {
    for (const tag of tags)
      await git(["update-ref", "-d", tag]).catch(() => undefined);
    await jjImport().catch(() => undefined);
  }
}

/** GitHub refused a read, as it does past a rate limit; it takes reads
 * again at `retryAt`. */
export class GitHubRefusedRead extends ReviewInputError {
  constructor(
    message: string,
    readonly retryAt: number,
  ) {
    super(message, 409);
  }
}

function unreadable(url: string, ghFailure: string, fallback: string) {
  return new ReviewInputError(
    `Could not read ${url}: gh failed (${ghFailure}) and ${fallback}. Run \`gh auth status\` and sign in with an account that can read the repository, then retry.`,
    409,
  );
}

function firstLine(text: string) {
  return text.split("\n")[0]!.slice(0, 300);
}
