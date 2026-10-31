import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  VcsProcessExitError,
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import type { ReviewDiffFileStat, VcsError } from "@t3tools/contracts";
import { quoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import type * as VcsDriver from "./VcsDriver.ts";

const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const WRITE_TIMEOUT_MS = 10 * 60_000;
const MAX_AHEAD_COUNT = 100;
const ARCANUM_REVIEW_URL = "https://a.yandex-team.ru/review/";
// Arc publishes user branches under users/<login>/; other server branches (trunk, releases/...)
// are shared bases that a local branch may track but must never be pushed to implicitly.
export const USER_BRANCH_PREFIX = "users/";

const decodeJson = <S extends Schema.Top>(schema: S) =>
  Schema.decodeEffect(Schema.fromJsonString(schema));
const decodeInfo = decodeJson(
  Schema.Struct({
    branch: Schema.optional(Schema.String),
    hash: Schema.optional(Schema.String),
    remote: Schema.optional(Schema.String),
    user_login: Schema.optional(Schema.String),
    counts: Schema.optional(
      Schema.Struct({
        ahead: Schema.optional(Schema.Number),
        behind: Schema.optional(Schema.Number),
      }),
    ),
  }),
);
const decodeMount = decodeJson(Schema.Struct({ default_branch: Schema.optional(Schema.String) }));
const decodeLog = decodeJson(
  Schema.Array(Schema.Struct({ commit: Schema.String, message: Schema.optional(Schema.String) })),
);
const decodeBranches = decodeJson(
  Schema.Array(Schema.Struct({ name: Schema.String, local: Schema.optional(Schema.Boolean) })),
);
const decodePullRequest = decodeJson(
  Schema.Struct({
    id: Schema.Number,
    url: Schema.optional(Schema.String),
    summary: Schema.optional(Schema.String),
    status: Schema.optional(Schema.String),
    from_branch: Schema.optional(Schema.String),
    to_branch: Schema.optional(Schema.String),
    updated_at: Schema.optional(Schema.Struct({ seconds: Schema.Number })),
  }),
);
const decodeCreatedPullRequest = decodeJson(
  Schema.Struct({ id: Schema.Number, url: Schema.optional(Schema.String) }),
);

const MISSING_PULL_REQUEST = /Can't find any PR|No pull request|No remote branch/;

function lastOutputLine(result: { readonly stdout: string; readonly stderr: string }) {
  const line = `${result.stderr}\n${result.stdout}`
    .split("\n")
    .map((value) => value.trim())
    .findLast((value) => value.length > 0);
  return line?.slice(0, 300);
}

function firstLine(message: string | undefined) {
  return message?.split("\n")[0]?.trim() ?? "";
}

function changeRequestState(status: string | undefined) {
  if (status === "merged") return "merged" as const;
  if (status === "discarded" || status === "closed") return "closed" as const;
  return "open" as const;
}

function filterPatch(diff: string, paths: ReadonlyArray<string>) {
  const headers = paths.map((value) => ` ${quoteGitPatchPath(`b/${value}`)}\n`);
  return diff
    .split(/(?=^diff --git )/m)
    .filter((chunk) =>
      headers.some((header) => chunk.slice(0, chunk.indexOf("\n") + 1).endsWith(header)),
    )
    .join("");
}

function summarizeFiles(files: ReadonlyArray<ReviewDiffFileStat>) {
  return files.map((file) => `${file.path} (+${file.additions} -${file.deletions})`).join("\n");
}

export interface ArcChangeOpsInput {
  readonly execute: VcsDriver.VcsDriver["Service"]["execute"];
  readonly readDiff: (cwd: string) => Effect.Effect<
    {
      readonly diff: string;
      readonly files: ReadonlyArray<ReviewDiffFileStat>;
    },
    VcsError
  >;
  readonly safeRelative: (value: string) => boolean;
}

export const make = ({
  execute,
  readDiff,
  safeRelative,
}: ArcChangeOpsInput): VcsDriver.VcsChangeOps => {
  const invalid = (cwd: string, operation: string, detail: string, cause?: unknown) =>
    new VcsRepositoryDetectionError({
      cwd,
      operation: `ArcVcsDriver.${operation}`,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const unsupported = (operation: string, detail: string) =>
    new VcsUnsupportedOperationError({
      kind: "arc",
      operation: `ArcVcsDriver.${operation}`,
      detail,
    });
  const run = Effect.fnUntraced(function* (
    cwd: string,
    operation: string,
    args: ReadonlyArray<string>,
    options?: { readonly timeoutMs?: number; readonly maxOutputBytes?: number },
  ) {
    const result = yield* execute({
      operation: `ArcVcsDriver.${operation}`,
      cwd,
      args,
      allowNonZeroExit: true,
      maxOutputBytes: MAX_METADATA_BYTES,
      ...options,
    });
    if (result.exitCode !== 0)
      return yield* new VcsProcessExitError({
        operation: `ArcVcsDriver.${operation}`,
        command: `arc ${args[0]}`,
        cwd,
        argumentCount: args.length,
        exitCode: result.exitCode,
        // Arc prints actionable reasons (hook failures, rejected pushes) as its last line.
        detail: lastOutputLine(result) ?? "Arc exited with a non-zero status.",
      });
    return result;
  });
  const runJson = <A>(
    cwd: string,
    operation: string,
    args: ReadonlyArray<string>,
    decode: (input: string) => Effect.Effect<A, Schema.SchemaError>,
    options?: { readonly timeoutMs?: number },
  ) =>
    run(cwd, operation, args, options).pipe(
      Effect.flatMap((result) =>
        decode(result.stdout).pipe(
          Effect.mapError((cause) =>
            invalid(cwd, operation, "Arc returned invalid metadata.", cause),
          ),
        ),
      ),
    );
  const readInfo = (cwd: string, args: ReadonlyArray<string> = []) =>
    runJson(cwd, "readInfo", ["info", "--json", ...args], decodeInfo);
  const readDefaultBranch = (cwd: string) =>
    runJson(cwd, "readDefaultBranch", ["info", "--json", "--mount"], decodeMount).pipe(
      Effect.map((mount) => mount.default_branch || "trunk"),
    );
  const readLog = (cwd: string, args: ReadonlyArray<string>) =>
    runJson(cwd, "readLog", ["log", "--json", ...args], decodeLog);

  const branchState = Effect.fn("ArcVcsDriver.branchState")(function* (cwd: string) {
    const [info, defaultBranch] = yield* Effect.all(
      [readInfo(cwd, ["--ahead-behind"]), readDefaultBranch(cwd)],
      { concurrency: "unbounded" },
    );
    const branch = info.branch || null;
    const remote = info.remote || null;
    const published = remote?.startsWith(USER_BRANCH_PREFIX) === true;
    // Without any tracked server branch, Arc reports no counts; measure against the default branch.
    const aheadCount =
      remote === null && branch !== null && branch !== defaultBranch
        ? (yield* readLog(cwd, ["-n", String(MAX_AHEAD_COUNT), `${defaultBranch}..HEAD`])).length
        : (info.counts?.ahead ?? 0);
    return {
      branch,
      defaultBranch,
      upstream: published ? remote : null,
      baseRef: published ? null : remote,
      aheadCount,
      // Behind a shared base is not something a push or a change request has to resolve first.
      behindCount: published ? (info.counts?.behind ?? 0) : 0,
    } satisfies VcsDriver.VcsChangeBranchState;
  });

  const findChangeRequest = Effect.fn("ArcVcsDriver.findChangeRequest")(function* (
    cwd: string,
    headRef: string,
  ) {
    const result = yield* execute({
      operation: "ArcVcsDriver.findChangeRequest",
      cwd,
      args: ["pr", "status", "--json", headRef],
      allowNonZeroExit: true,
      maxOutputBytes: MAX_METADATA_BYTES,
    });
    if (result.exitCode !== 0) {
      if (MISSING_PULL_REQUEST.test(`${result.stderr}\n${result.stdout}`)) return null;
      return yield* new VcsProcessExitError({
        operation: "ArcVcsDriver.findChangeRequest",
        command: "arc pr",
        cwd,
        exitCode: result.exitCode,
        detail: lastOutputLine(result) ?? "Arc exited with a non-zero status.",
      });
    }
    const pr = yield* decodePullRequest(result.stdout).pipe(
      Effect.mapError((cause) =>
        invalid(cwd, "findChangeRequest", "Arc returned invalid pull request metadata.", cause),
      ),
    );
    if (pr.from_branch !== undefined && pr.from_branch !== headRef) return null;
    const updatedAt =
      pr.updated_at === undefined
        ? null
        : DateTime.formatIso(DateTime.makeUnsafe(pr.updated_at.seconds * 1000));
    return {
      number: pr.id,
      title: pr.summary?.trim() || `PR ${pr.id}`,
      url: pr.url || `${ARCANUM_REVIEW_URL}${pr.id}`,
      baseRef: pr.to_branch || "trunk",
      headRef,
      state: changeRequestState(pr.status),
      ...(pr.status === "draft" ? { isDraft: true } : {}),
      updatedAt,
    } satisfies VcsDriver.VcsChangeRequest;
  });

  const checkPaths = (cwd: string, operation: string, paths: ReadonlyArray<string>) =>
    paths.every(safeRelative)
      ? Effect.void
      : Effect.fail(invalid(cwd, operation, "File paths must stay within the project."));

  return {
    branchState,
    findChangeRequest,
    remoteStatus: Effect.fn("ArcVcsDriver.remoteStatus")(function* (cwd) {
      const state = yield* branchState(cwd);
      const pr =
        state.upstream !== null && state.branch !== state.defaultBranch
          ? yield* findChangeRequest(cwd, state.upstream).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Arc pull request lookup failed.", {
                  errorTag: error._tag,
                }).pipe(Effect.as(null)),
              ),
            )
          : null;
      return {
        hasUpstream: state.upstream !== null,
        aheadCount: state.aheadCount,
        behindCount: state.behindCount,
        pr,
      };
    }),
    prepareCommitContext: Effect.fn("ArcVcsDriver.prepareCommitContext")(
      function* (cwd, filePaths) {
        const result = yield* readDiff(cwd);
        const files = filePaths
          ? result.files.filter((file) => filePaths.includes(file.path))
          : result.files;
        if (files.length === 0) return null;
        return {
          stagedSummary: summarizeFiles(files),
          stagedPatch: filePaths ? filterPatch(result.diff, filePaths) : result.diff,
        };
      },
    ),
    recentCommitSubjects: Effect.fn("ArcVcsDriver.recentCommitSubjects")(function* (cwd) {
      const commits = yield* readLog(cwd, ["-n", "20"]);
      return commits.map((commit) => firstLine(commit.message)).filter(Boolean);
    }),
    listBranchNames: Effect.fn("ArcVcsDriver.listBranchNames")(function* (cwd) {
      const branches = yield* runJson(cwd, "listBranchNames", ["branch", "--json"], decodeBranches);
      return branches.filter((branch) => branch.local !== false).map((branch) => branch.name);
    }),
    createBranch: Effect.fn("ArcVcsDriver.createBranch")(function* (cwd, name) {
      yield* run(cwd, "createBranch", ["checkout", "--no-track", "-b", name]);
    }),
    commit: Effect.fn("ArcVcsDriver.commit")(function* (cwd, message, filePaths) {
      // Status and diffs are scoped to the project directory, so commits are too.
      const paths = filePaths && filePaths.length > 0 ? filePaths : ["."];
      if (filePaths) yield* checkPaths(cwd, "commit", filePaths);
      yield* run(cwd, "commit", ["add", "--all", "--", ...paths]);
      yield* run(cwd, "commit", ["commit", "--no-edit", "--message", message, "--", ...paths], {
        timeoutMs: WRITE_TIMEOUT_MS,
      });
      const info = yield* readInfo(cwd);
      if (!info.hash) return yield* invalid(cwd, "commit", "Arc did not report the new commit.");
      return { commitSha: info.hash };
    }),
    push: Effect.fn("ArcVcsDriver.push")(function* (cwd) {
      const [info, defaultBranch] = yield* Effect.all([readInfo(cwd), readDefaultBranch(cwd)], {
        concurrency: "unbounded",
      });
      if (!info.branch) return yield* unsupported("push", "Cannot push from detached HEAD.");
      if (info.branch === defaultBranch)
        return yield* unsupported(
          "push",
          `Arc does not push to ${defaultBranch}. Commit on a feature branch instead.`,
        );
      if (info.remote?.startsWith(USER_BRANCH_PREFIX)) {
        yield* run(cwd, "push", ["push"], { timeoutMs: WRITE_TIMEOUT_MS });
        return { upstream: info.remote, setUpstream: false };
      }
      if (!info.user_login)
        return yield* invalid(cwd, "push", "Arc did not report the signed-in user.");
      const userPrefix = `${USER_BRANCH_PREFIX}${info.user_login}/`;
      const upstream = info.branch.startsWith(userPrefix)
        ? info.branch
        : `${userPrefix}${info.branch}`;
      yield* run(cwd, "push", ["push", "--set-upstream", upstream], {
        timeoutMs: WRITE_TIMEOUT_MS,
      });
      return { upstream, setUpstream: true };
    }),
    readRangeContext: Effect.fn("ArcVcsDriver.readRangeContext")(function* (cwd, baseRef) {
      const [commits, stat, patch] = yield* Effect.all(
        [
          readLog(cwd, ["-n", "50", `${baseRef}..HEAD`]),
          run(cwd, "readRangeContext", ["diff", "--stat", "--no-color", "--base", baseRef, "HEAD"]),
          run(cwd, "readRangeContext", ["diff", "--git", "--no-color", "--base", baseRef, "HEAD"], {
            maxOutputBytes: MAX_PATCH_BYTES,
          }),
        ],
        { concurrency: "unbounded" },
      );
      return {
        commitSummary: commits
          .map((commit) => `${commit.commit.slice(0, 7)} ${firstLine(commit.message)}`)
          .join("\n"),
        diffSummary: stat.stdout,
        diffPatch: patch.stdout,
      };
    }),
    createChangeRequest: Effect.fn("ArcVcsDriver.createChangeRequest")(function* (input) {
      const message = input.body.trim() ? `${input.title}\n\n${input.body.trim()}` : input.title;
      const created = yield* runJson(
        input.cwd,
        "createChangeRequest",
        [
          "pr",
          "create",
          "--push",
          "--json",
          "--no-commits",
          "--no-edit",
          "--message",
          message,
          ...(input.baseRef ? ["--to", input.baseRef] : []),
        ],
        decodeCreatedPullRequest,
        { timeoutMs: WRITE_TIMEOUT_MS },
      );
      return { number: created.id, url: created.url || `${ARCANUM_REVIEW_URL}${created.id}` };
    }),
  };
};
