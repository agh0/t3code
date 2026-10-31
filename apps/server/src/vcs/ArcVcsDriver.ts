import { createTwoFilesPatch, parsePatch } from "diff";
import * as Cache from "effect/Cache";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { VcsRepositoryDetectionError, VcsUnsupportedOperationError } from "@t3tools/contracts";
import type { ReviewDiffFileStat, ReviewDiffPreviewSource, VcsError } from "@t3tools/contracts";
import { quoteGitPatchPath, unquoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ArcChangeOps from "./ArcChangeOps.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const WORKING_COPY_MAX_AGE = Duration.minutes(1);
const MOUNT_COUNTER_ATTRIBUTE = "user.arc.get.counter";
const Entry = Schema.Struct({ path: Schema.String, status: Schema.String, type: Schema.String });
const Status = Schema.Struct({
  branch_info: Schema.optional(
    Schema.Struct({ local: Schema.optional(Schema.Struct({ name: Schema.String })) }),
  ),
  status: Schema.Record(Schema.String, Schema.Array(Entry)),
});
const decodeStatus = Schema.decodeEffect(Schema.fromJsonString(Status));
const decodeInfo = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      branch: Schema.optional(Schema.String),
      remote: Schema.optional(Schema.String),
    }),
  ),
);
// A release branch against trunk did not finish in minutes; such a branch gets no branch range.
const MERGE_BASE_TIMEOUT_MS = 120_000;
// The diff preview stops waiting for a slow merge-base, which keeps running for the next preview.
const MERGE_BASE_PREVIEW_WAIT = Duration.seconds(2);
const MAX_LOG_BYTES = 1024 * 1024;
const BRANCH_COMMIT_LIMIT = 100;
const SUBJECT_LIMIT = 300;
const COMMIT_ID = /^[0-9a-f]{40}$/i;
const LogEntry = Schema.Struct({
  commit: Schema.String,
  parents: Schema.optional(Schema.Array(Schema.String)),
  date: Schema.String,
  message: Schema.String,
});
const decodeLogEntry = Schema.decodeEffect(Schema.fromJsonString(LogEntry));
const decodeLog = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(LogEntry)));
const decodeMount = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ repository: Schema.String, default_branch: Schema.String }),
  ),
);
const decodeMergeBase = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ base: Schema.String })),
);
const decodeNames = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ names: Schema.Array(Schema.Struct({ path: Schema.String })) })),
  ),
);
const subjectOf = (message: string) => message.split("\n", 1)[0]!.trim().slice(0, SUBJECT_LIMIT);
interface ChangedFiles {
  readonly branch: string | null;
  readonly entries: ReadonlyArray<{ readonly path: string; readonly untracked: boolean }>;
}
interface DiffRange {
  readonly from: string;
  readonly to?: string;
  readonly changed?: ChangedFiles;
}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const process = yield* VcsProcess.VcsProcess;
  const crypto = yield* Crypto.Crypto;
  const platform = yield* HostProcess.Platform;
  const execute: VcsDriver.VcsDriver["Service"]["execute"] = (input) =>
    process.run({ timeoutMs: 120_000, ...input, command: "arc" });
  const invalid = (cwd: string, operation: string, detail: string, cause?: unknown) =>
    new VcsRepositoryDetectionError({
      cwd,
      operation: `ArcVcsDriver.${operation}`,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const unsupported = (operation: string) =>
    Effect.fail(
      new VcsUnsupportedOperationError({
        kind: "arc",
        operation: `ArcVcsDriver.${operation}`,
        detail: "Arc does not support this operation.",
      }),
    );
  const freshness = () =>
    DateTime.now.pipe(
      Effect.map((observedAt) => ({
        source: "live-local" as const,
        observedAt,
        expiresAt: Option.none(),
      })),
    );
  const inside = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const safeRelative = (value: string) =>
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.split(/[\\/]/).some((part) => part === ".." || part === ".arc" || part === ".git") &&
    !value.includes("\0");

  const findRoot = Effect.fn("ArcVcsDriver.findRoot")(
    function* (cwd: string) {
      let current = path.resolve(cwd);
      while (true) {
        if (yield* fs.exists(path.join(current, ".arc"))) return current;
        if (yield* fs.exists(path.join(current, ".git"))) return null;
        const parent = path.dirname(current);
        if (parent === current) return null;
        current = parent;
      }
    },
    (effect, cwd) =>
      effect.pipe(
        Effect.mapError((cause) =>
          invalid(cwd, "findRoot", "Failed to inspect Arc metadata.", cause),
        ),
      ),
  );

  const detectRepository: VcsDriver.VcsDriver["Service"]["detectRepository"] = Effect.fn(
    "ArcVcsDriver.detectRepository",
  )(function* (cwd) {
    const root = yield* findRoot(cwd);
    if (root === null) return null;
    return {
      kind: "arc" as const,
      rootPath: root,
      metadataPath: path.join(root, ".arc"),
      freshness: yield* freshness(),
    };
  });
  const repositoryRoot = Effect.fn("ArcVcsDriver.repositoryRoot")(function* (cwd: string) {
    const root = yield* findRoot(cwd);
    if (root === null)
      return yield* invalid(cwd, "repositoryRoot", "No Arc working copy was found.");
    return root;
  });
  const projectPath = (cwd: string, root: string, value: string) => {
    if (!safeRelative(value)) return null;
    const target = path.resolve(root, value);
    if (!inside(path.resolve(cwd), target)) return null;
    return path.relative(cwd, target).split(path.sep).join("/");
  };
  const readStatus = Effect.fn("ArcVcsDriver.readStatus")(function* (
    cwd: string,
    paths: ReadonlyArray<string> = ["."],
    ignored = false,
  ) {
    const result = yield* execute({
      operation: "ArcVcsDriver.readStatus",
      cwd,
      args: [
        "status",
        "--json",
        "--branch",
        "--no-ahead-behind",
        "--no-sync-status",
        "--no-bisect-status",
        "-u",
        "all",
        ...(ignored ? ["--ignored"] : []),
        "--",
        ...paths,
      ],
      maxOutputBytes: MAX_METADATA_BYTES,
    });
    if (result.stdoutTruncated)
      return yield* invalid(cwd, "readStatus", "Arc status exceeds the response limit.");
    return yield* decodeStatus(result.stdout).pipe(
      Effect.mapError((cause) =>
        invalid(cwd, "readStatus", "Arc returned invalid status metadata.", cause),
      ),
    );
  });
  const readInfo = Effect.fn("ArcVcsDriver.readInfo")(function* (cwd: string) {
    const result = yield* execute({
      operation: "ArcVcsDriver.readInfo",
      cwd,
      args: ["info", "--json"],
      maxOutputBytes: 64 * 1024,
    });
    if (result.stdoutTruncated)
      return yield* invalid(cwd, "readInfo", "Arc branch metadata exceeds the response limit.");
    return yield* decodeInfo(result.stdout).pipe(
      Effect.mapError((cause) =>
        invalid(cwd, "readInfo", "Arc returned invalid branch metadata.", cause),
      ),
    );
  });
  const currentBranch = Effect.fn("ArcVcsDriver.currentBranch")(function* (cwd: string) {
    return (yield* readInfo(cwd)).branch || null;
  });
  const changedFiles = Effect.fn("ArcVcsDriver.changedFiles")(function* (cwd: string) {
    const root = yield* repositoryRoot(cwd);
    const status = yield* readStatus(cwd);
    const entries = new Map<string, { path: string; untracked: boolean }>();
    for (const [group, files] of Object.entries(status.status)) {
      if (group === "ignored") continue;
      for (const file of files) {
        const relative = projectPath(cwd, root, file.path);
        if (relative && file.type !== "directory")
          entries.set(relative, { path: relative, untracked: group === "untracked" });
      }
    }
    return { branch: status.branch_info?.local?.name || null, entries: [...entries.values()] };
  });
  const readFile = Effect.fn("ArcVcsDriver.readFile")(
    function* (cwd: string, relative: string) {
      if (!safeRelative(relative))
        return yield* invalid(cwd, "readFile", "File paths must stay within the project.");
      const root = yield* fs.realPath(cwd);
      const target = yield* fs.realPath(path.resolve(cwd, relative));
      if (!inside(root, target))
        return yield* invalid(cwd, "readFile", "File paths must stay within the project.");
      const stat = yield* fs.stat(target);
      if (stat.size > MAX_FILE_BYTES) return { kind: "too-large" as const };
      if (stat.type !== "File")
        return yield* invalid(cwd, "readFile", "Only regular files can be previewed.");
      const bytes = yield* fs.readFile(target);
      if (bytes.length > MAX_FILE_BYTES) return { kind: "too-large" as const };
      if (bytes.includes(0)) return { kind: "binary" as const };
      return {
        kind: "text" as const,
        text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes),
      };
    },
    (effect, cwd) =>
      effect.pipe(
        Effect.mapError((cause): VcsError =>
          cause._tag === "VcsRepositoryDetectionError"
            ? cause
            : invalid(cwd, "readFile", "Could not read the working copy file.", cause),
        ),
      ),
  );

  const readChangedPaths = Effect.fn("ArcVcsDriver.readChangedPaths")(function* (
    cwd: string,
    revisions: ReadonlyArray<string>,
    selected: ReadonlyArray<string>,
  ) {
    const result = yield* execute({
      operation: "ArcVcsDriver.readChangedPaths",
      cwd,
      args: ["diff", "--name-status", "--json", "--relative=.", ...revisions, "--", ...selected],
      maxOutputBytes: MAX_METADATA_BYTES,
    });
    if (result.stdoutTruncated)
      return yield* invalid(
        cwd,
        "readChangedPaths",
        "Arc changed files exceed the response limit.",
      );
    const groups = yield* decodeNames(result.stdout).pipe(
      Effect.mapError((cause) =>
        invalid(cwd, "readChangedPaths", "Arc returned invalid changed files.", cause),
      ),
    );
    return groups.flatMap((group) => group.names.map((name) => name.path)).filter(safeRelative);
  });
  const readHead = Effect.fn("ArcVcsDriver.readHead")(function* (cwd: string) {
    const result = yield* execute({
      operation: "ArcVcsDriver.readHead",
      cwd,
      args: ["rev-parse", "HEAD"],
      maxOutputBytes: 1024,
    });
    const head = result.stdout.trim();
    if (!COMMIT_ID.test(head))
      return yield* invalid(cwd, "readHead", "Arc returned an invalid HEAD commit.");
    return head;
  });
  const mounts = new Map<string, { repository: string; defaultBranch: string }>();
  const readMount = Effect.fn("ArcVcsDriver.readMount")(function* (cwd: string, root: string) {
    const cached = mounts.get(root);
    if (cached) return cached;
    const result = yield* execute({
      operation: "ArcVcsDriver.readMount",
      cwd,
      args: ["info", "--json", "--mount"],
      maxOutputBytes: 64 * 1024,
    });
    const mount = yield* decodeMount(result.stdout).pipe(
      Effect.mapError((cause) =>
        invalid(cwd, "readMount", "Arc returned invalid mount metadata.", cause),
      ),
    );
    const value = { repository: mount.repository, defaultBranch: mount.default_branch };
    mounts.set(root, value);
    return value;
  });
  // A branch tracking a release branch is compared with it, not with trunk, which it left long ago.
  const defaultBaseRef = Effect.fn("ArcVcsDriver.defaultBaseRef")(function* (
    cwd: string,
    root: string,
  ) {
    const [mount, info] = yield* Effect.all([readMount(cwd, root), readInfo(cwd)], {
      concurrency: 2,
    });
    const remote =
      info.remote && !info.remote.startsWith(ArcChangeOps.USER_BRANCH_PREFIX) ? info.remote : null;
    return `${mount.repository}/${remote ?? mount.defaultBranch}`;
  });
  const mergeBases = yield* Cache.makeWith(
    (key: string) => {
      const [cwd, baseRef] = key.split("\0") as [string, string];
      return execute({
        operation: "ArcVcsDriver.resolveBase",
        cwd,
        args: ["merge-base", "--json", "--leftmost", baseRef, "HEAD"],
        timeoutMs: MERGE_BASE_TIMEOUT_MS,
        maxOutputBytes: 64 * 1024,
      }).pipe(
        Effect.flatMap((result) => decodeMergeBase(result.stdout)),
        Effect.map(({ base }) => (COMMIT_ID.test(base) ? base : null)),
        // A timed-out merge-base stays unresolved for this HEAD instead of rerunning every preview.
        Effect.catchTags({ VcsProcessTimeoutError: () => Effect.succeed(null) }),
      );
    },
    {
      capacity: 256,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    },
  );
  /** Resolves to null when Arc cannot name a base, so callers can drop the branch range. */
  const resolveBase = Effect.fn("ArcVcsDriver.resolveBase")(
    function* (
      cwd: string,
      explicitBaseRef?: string | null,
      wait: Duration.Duration = Duration.infinity,
    ) {
      const root = yield* repositoryRoot(cwd);
      const baseRef = explicitBaseRef || (yield* defaultBaseRef(cwd, root));
      if (baseRef.startsWith("-")) return null;
      // The key carries HEAD so a new commit gets a new merge-base; cwd only runs the command.
      const key = `${cwd}\0${baseRef}\0${yield* readHead(cwd)}`;
      const fiber = yield* Cache.get(mergeBases, key).pipe(Effect.forkDetach);
      const mergeBase = yield* Fiber.join(fiber).pipe(Effect.timeoutOption(wait));
      return Option.isSome(mergeBase) && mergeBase.value
        ? { baseRef, mergeBase: mergeBase.value }
        : null;
    },
    // Other failures, such as an unreachable Arc server, are not cached and retry next time.
    (effect) => effect.pipe(Effect.orElseSucceed(() => null)),
  );
  const resolveCommit = Effect.fn("ArcVcsDriver.resolveCommit")(function* (
    cwd: string,
    sha: string,
  ) {
    const missing = invalid(
      cwd,
      "resolveCommit",
      "Selected commit is invalid or no longer available.",
    );
    if (!COMMIT_ID.test(sha)) return yield* missing;
    const result = yield* execute({
      operation: "ArcVcsDriver.resolveCommit",
      cwd,
      args: ["log", "--json", "--no-walk", "-n", "1", sha],
      maxOutputBytes: MAX_METADATA_BYTES,
    }).pipe(Effect.mapError(() => missing));
    const [entry] = yield* decodeLog(result.stdout).pipe(Effect.mapError(() => missing));
    if (!entry || entry.commit.toLowerCase() !== sha.toLowerCase()) return yield* missing;
    const parent = entry.parents?.[0];
    if (!parent)
      return yield* invalid(cwd, "resolveCommit", "Selected commit has no parent to compare.");
    return { sha: entry.commit, parent, subject: subjectOf(entry.message) };
  });
  const hashDiff = (cwd: string, diff: string, files: ReadonlyArray<ReviewDiffFileStat>) =>
    crypto
      .digest(
        "SHA-256",
        new TextEncoder().encode(diff + "\0" + files.map((file) => file.path).join("\0")),
      )
      .pipe(
        Effect.map(Hex.encode),
        Effect.mapError((cause) =>
          invalid(cwd, "getDiffPreview", "Failed to hash Arc diff.", cause),
        ),
      );

  const readRevisionFile = Effect.fn("ArcVcsDriver.readRevisionFile")(function* (
    cwd: string,
    root: string,
    revision: string,
    relative: string,
  ) {
    const target = path.relative(root, path.resolve(cwd, relative)).split(path.sep).join("/");
    const result = yield* execute({
      operation: "ArcVcsDriver.getDiffFileContents",
      cwd,
      args: ["show", `${revision}:${target}`],
      maxOutputBytes: MAX_FILE_BYTES,
    });
    if (result.stdoutTruncated || result.stdout.includes("\0"))
      return yield* invalid(
        cwd,
        "getDiffFileContents",
        "File contents exceed the text preview limit.",
      );
    return result.stdout;
  });

  const readDiff = Effect.fn("ArcVcsDriver.readDiff")(function* (
    cwd: string,
    file?: { path: string; previousPath: string | null },
    ignoreWhitespace = false,
    range: DiffRange = { from: "HEAD" },
  ) {
    // Two-commit diffs do not involve the working copy, so they skip its status.
    const changed = range.to ? null : (range.changed ?? (yield* changedFiles(cwd)));
    const selected = file ? [file.path, ...(file.previousPath ? [file.previousPath] : [])] : ["."];
    if (file && selected.some((name) => !safeRelative(name)))
      return yield* invalid(cwd, "readDiff", "File paths must stay within the project.");
    const revisions = [range.from, ...(range.to ? [range.to] : [])];
    const result = yield* execute({
      operation: "ArcVcsDriver.readDiff",
      cwd,
      args: [
        "diff",
        "--git",
        "--no-color",
        "--relative=.",
        ...(ignoreWhitespace ? ["--ignore-all-space"] : []),
        ...revisions,
        "--",
        ...selected,
      ],
      maxOutputBytes: MAX_PATCH_BYTES,
    });
    let diff = result.stdoutTruncated
      ? result.stdout.slice(0, Math.max(0, result.stdout.lastIndexOf("\ndiff --git ") + 1))
      : result.stdout;
    let truncated = result.stdoutTruncated;
    let remaining = result.stdoutTruncated
      ? 0
      : MAX_PATCH_BYTES - new TextEncoder().encode(diff).byteLength;
    for (const entry of changed?.entries ?? []) {
      if (!entry.untracked || (file && !selected.includes(entry.path))) continue;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      // Broken or escaping symlinks and unreadable files must not fail the whole status.
      const content = yield* readFile(cwd, entry.path).pipe(Effect.orElseSucceed(() => null));
      if (content === null) continue;
      if (content.kind === "too-large") {
        truncated = true;
        continue;
      }
      const oldName = quoteGitPatchPath(`a/${entry.path}`);
      const newName = quoteGitPatchPath(`b/${entry.path}`);
      const header = `diff --git ${oldName} ${newName}\nnew file mode 100644\n`;
      const patch =
        header +
        (content.kind === "binary"
          ? `Binary files /dev/null and ${newName} differ\n`
          : createTwoFilesPatch("/dev/null", newName, "", content.text).replace(/^=+\n/, ""));
      const bytes = new TextEncoder().encode(patch).byteLength;
      if (bytes > remaining) {
        truncated = true;
        continue;
      }
      diff += patch;
      remaining -= bytes;
    }
    const parsed = yield* Effect.try({
      try: () => parsePatch(diff),
      catch: (cause) => invalid(cwd, "readDiff", "Arc returned an invalid patch.", cause),
    });
    const stats = new Map<string, ReviewDiffFileStat>();
    for (const patch of parsed) {
      const newPath = patch.newFileName && unquoteGitPatchPath(patch.newFileName);
      const oldPath = patch.oldFileName && unquoteGitPatchPath(patch.oldFileName);
      const filePath =
        newPath && newPath !== "/dev/null"
          ? newPath.replace(/^b\//, "")
          : oldPath?.replace(/^a\//, "");
      if (!filePath || !safeRelative(filePath)) continue;
      const lines = patch.hunks.flatMap((hunk) => hunk.lines);
      stats.set(filePath, {
        path: filePath,
        previousPath:
          oldPath && oldPath !== "/dev/null" && oldPath.replace(/^a\//, "") !== filePath
            ? oldPath.replace(/^a\//, "")
            : null,
        additions: lines.filter((line) => line.startsWith("+")).length,
        deletions: lines.filter((line) => line.startsWith("-")).length,
      });
    }
    const untracked = (changed?.entries ?? []).filter(
      (entry) => entry.untracked && (!file || selected.includes(entry.path)),
    );
    // Status lists every uncommitted file; other ranges list what the patch and untracked files hold.
    const paths =
      changed && !range.to && range.from === "HEAD"
        ? changed.entries
            .filter((entry) => !file || selected.includes(entry.path))
            .map((entry) => entry.path)
        : [
            ...new Set([
              ...stats.keys(),
              ...untracked.map((entry) => entry.path),
              ...(truncated ? yield* readChangedPaths(cwd, revisions, selected) : []),
            ]),
          ];
    const files = paths.map(
      (filePath) =>
        stats.get(filePath) ?? { path: filePath, previousPath: null, additions: 0, deletions: 0 },
    );
    return { diff, files, truncated, branch: changed?.branch ?? null, changed };
  });

  const counterCommand =
    platform === "darwin"
      ? { command: "/usr/bin/xattr", args: ["-p", MOUNT_COUNTER_ATTRIBUTE] }
      : platform === "linux"
        ? { command: "getfattr", args: ["--only-values", "-n", MOUNT_COUNTER_ATTRIBUTE] }
        : null;
  // Arc's FUSE mount bumps this counter on every write, so an unchanged counter and `arc info`
  // prove the working copy is unchanged. nativefs copies have no counter and always rerun status.
  const readFingerprint = Effect.fn("ArcVcsDriver.readFingerprint")(function* (cwd: string) {
    if (counterCommand === null) return null;
    const root = yield* repositoryRoot(cwd);
    const counter = yield* process
      .run({
        operation: "ArcVcsDriver.readFingerprint",
        cwd,
        command: counterCommand.command,
        args: [...counterCommand.args, root],
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 1024,
      })
      .pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.orElseSucceed(() => ""),
      );
    if (!/^\d+\0?$/.test(counter)) return null;
    const info = yield* execute({
      operation: "ArcVcsDriver.readFingerprint",
      cwd,
      args: ["info", "--json"],
      maxOutputBytes: 64 * 1024,
    });
    return info.stdoutTruncated ? null : `${counter}\0${info.stdout}`;
  });
  // Status refreshes invalidate GitWorkflowService's cache every time, so only the fingerprint
  // decides reuse here; the max age bounds anything the counter might miss.
  const workingCopyKeys = new Map<string, string>();
  const workingCopyCache = yield* Cache.makeWith(
    (key: string) => readDiff(key.slice(0, key.indexOf("\0"))),
    {
      capacity: 16,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? WORKING_COPY_MAX_AGE : Duration.zero),
    },
  );
  const readWorkingCopy = Effect.fn("ArcVcsDriver.readWorkingCopy")(function* (cwd: string) {
    const fingerprint = yield* readFingerprint(cwd);
    if (fingerprint === null) return yield* readDiff(cwd);
    const key = `${cwd}\0${fingerprint}`;
    const previous = workingCopyKeys.get(cwd);
    if (previous !== undefined && previous !== key)
      yield* Cache.invalidate(workingCopyCache, previous);
    workingCopyKeys.set(cwd, key);
    return yield* Cache.get(workingCopyCache, key);
  });

  const workingTree: VcsDriver.VcsWorkingTreeOps = {
    currentBranch,
    localStatus: Effect.fn("ArcVcsDriver.localStatus")(function* ({ cwd }) {
      const result = yield* readWorkingCopy(cwd);
      const files = result.files.map((file) => ({
        path: file.path,
        insertions: file.additions,
        deletions: file.deletions,
      }));
      return {
        isRepo: true,
        supportsMutations: false,
        supportsStackedActions: true,
        hasPrimaryRemote: true,
        isDefaultRef: result.branch === "trunk",
        refName: result.branch,
        hasWorkingTreeChanges: files.length > 0,
        workingTree: {
          rootPath: cwd,
          files,
          insertions: files.reduce((sum, file) => sum + file.insertions, 0),
          deletions: files.reduce((sum, file) => sum + file.deletions, 0),
        },
      };
    }),
    listRefs: Effect.fn("ArcVcsDriver.listRefs")(function* (input) {
      const branch = yield* currentBranch(input.cwd);
      const refs =
        branch &&
        input.refKind !== "remote" &&
        (!input.query || branch.toLowerCase().includes(input.query.toLowerCase()))
          ? [
              {
                name: branch,
                current: true,
                isDefault: branch === "trunk",
                worktreePath: input.cwd,
              },
            ]
          : [];
      return {
        isRepo: true,
        supportsMutations: false,
        supportsStackedActions: true,
        hasPrimaryRemote: true,
        refs,
        totalCount: refs.length,
        nextCursor: null,
      };
    }),
    getDiffPreview: Effect.fn("ArcVcsDriver.getDiffPreview")(function* (input) {
      const kind = input.file?.sourceKind;
      if (input.commitSha !== undefined || kind === "commit") {
        if (!input.commitSha || (input.file && kind !== "commit"))
          return yield* invalid(input.cwd, "getDiffPreview", "Selected commit request is invalid.");
        const commit = yield* resolveCommit(input.cwd, input.commitSha);
        const result = yield* readDiff(input.cwd, input.file, input.ignoreWhitespace, {
          from: commit.parent,
          to: commit.sha,
        });
        return {
          cwd: input.cwd,
          generatedAt: yield* DateTime.now,
          sources: [
            {
              id: commit.sha,
              kind: "commit" as const,
              title: `Commit ${commit.sha.slice(0, 7)}`,
              ...(commit.subject ? { commitSubject: commit.subject } : {}),
              baseRef: commit.parent,
              headRef: commit.sha,
              diff: result.diff,
              files: result.files,
              diffHash: yield* hashDiff(input.cwd, result.diff, result.files),
              truncated: result.truncated,
            },
          ],
        };
      }
      const [uncommitted, base] = yield* Effect.all(
        [
          kind === "branch-range"
            ? Effect.succeed(null)
            : !input.file && !input.ignoreWhitespace
              ? readWorkingCopy(input.cwd)
              : readDiff(input.cwd, input.file, input.ignoreWhitespace),
          kind === "working-tree"
            ? Effect.succeed(null)
            : resolveBase(input.cwd, input.baseRef, MERGE_BASE_PREVIEW_WAIT),
        ],
        { concurrency: 2 },
      );
      // Like Git, the branch range runs from the merge-base to the working copy, not to HEAD.
      const branch = base
        ? yield* readDiff(input.cwd, input.file, input.ignoreWhitespace, {
            from: base.mergeBase,
            changed: uncommitted?.changed ?? (yield* changedFiles(input.cwd)),
          })
        : null;
      const sources: ReviewDiffPreviewSource[] = [];
      if (uncommitted)
        sources.push({
          id: "working-tree",
          kind: "working-tree",
          title: "Uncommitted",
          baseRef: "HEAD",
          headRef: null,
          diff: uncommitted.diff,
          files: uncommitted.files,
          diffHash: yield* hashDiff(input.cwd, uncommitted.diff, uncommitted.files),
          truncated: uncommitted.truncated,
        });
      if (base && branch)
        sources.push({
          id: "branch-range",
          kind: "branch-range",
          title: `Changes vs ${base.baseRef}`,
          baseRef: base.baseRef,
          headRef: branch.branch ?? "HEAD",
          diff: branch.diff,
          files: branch.files,
          diffHash: yield* hashDiff(input.cwd, branch.diff, branch.files),
          truncated: branch.truncated,
        });
      return { cwd: input.cwd, generatedAt: yield* DateTime.now, sources };
    }),
    getDiffFileContents: Effect.fn("ArcVcsDriver.getDiffFileContents")(function* (input) {
      if (![input.oldPath, input.newPath].every(safeRelative))
        return yield* invalid(
          input.cwd,
          "getDiffFileContents",
          "File paths must stay within the project.",
        );
      let oldRevision = "HEAD";
      let newRevision: string | null = null;
      if (input.sourceKind === "commit") {
        if (!input.headRef)
          return yield* invalid(
            input.cwd,
            "getDiffFileContents",
            "Selected commit is no longer available.",
          );
        const commit = yield* resolveCommit(input.cwd, input.headRef);
        if (input.baseRef !== commit.parent)
          return yield* invalid(
            input.cwd,
            "getDiffFileContents",
            "Selected commit changed. Refresh the comparison.",
          );
        oldRevision = commit.parent;
        newRevision = commit.sha;
      } else if (input.sourceKind === "branch-range") {
        const base = yield* resolveBase(input.cwd, input.baseRef);
        if (!base)
          return yield* invalid(
            input.cwd,
            "getDiffFileContents",
            "Could not resolve the branch comparison base.",
          );
        oldRevision = base.mergeBase;
      } else if (input.headRef !== null || (input.baseRef !== null && input.baseRef !== "HEAD")) {
        return yield* unsupported("getDiffFileContents");
      }
      const root = yield* repositoryRoot(input.cwd);
      const readWorkingCopy = readFile(input.cwd, input.newPath).pipe(
        Effect.flatMap((current) =>
          current.kind === "text"
            ? Effect.succeed(current.text)
            : Effect.fail(
                invalid(
                  input.cwd,
                  "getDiffFileContents",
                  "File contents exceed the text preview limit.",
                ),
              ),
        ),
      );
      const [oldContents, newContents] = yield* Effect.all(
        [
          input.changeType === "new"
            ? Effect.succeed("")
            : readRevisionFile(input.cwd, root, oldRevision, input.oldPath),
          input.changeType === "deleted"
            ? Effect.succeed("")
            : newRevision
              ? readRevisionFile(input.cwd, root, newRevision, input.newPath)
              : readWorkingCopy,
        ],
        { concurrency: 2 },
      );
      return { oldContents, newContents };
    }),
    getBranchCommits: Effect.fn("ArcVcsDriver.getBranchCommits")(function* (input) {
      const base = yield* resolveBase(input.cwd, input.baseRef);
      if (!base) return { commits: [], truncated: false };
      const result = yield* execute({
        operation: "ArcVcsDriver.getBranchCommits",
        cwd: input.cwd,
        args: [
          "log",
          "--json-lines",
          "-n",
          String(BRANCH_COMMIT_LIMIT + 1),
          `${base.mergeBase}..HEAD`,
        ],
        maxOutputBytes: MAX_LOG_BYTES,
      });
      // Each commit is one line, so a truncated read keeps the complete ones.
      const lines = result.stdout.split("\n");
      if (result.stdoutTruncated) lines.pop();
      const commits: Array<{ sha: string; subject: string; committedAt: string }> = [];
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        const entry = yield* decodeLogEntry(line).pipe(
          Effect.mapError((cause) =>
            invalid(input.cwd, "getBranchCommits", "Arc returned invalid commit metadata.", cause),
          ),
        );
        if (!COMMIT_ID.test(entry.commit))
          return yield* invalid(
            input.cwd,
            "getBranchCommits",
            "Arc returned invalid commit metadata.",
          );
        commits.push({
          sha: entry.commit,
          subject: subjectOf(entry.message),
          committedAt: entry.date,
        });
      }
      if (result.stdoutTruncated && commits.length === 0)
        return yield* invalid(
          input.cwd,
          "getBranchCommits",
          "Branch commit metadata exceeds the response limit.",
        );
      return {
        commits: commits.slice(0, BRANCH_COMMIT_LIMIT),
        truncated: result.stdoutTruncated || commits.length > BRANCH_COMMIT_LIMIT,
      };
    }),
  };
  const listWorkspaceFiles: VcsDriver.VcsDriver["Service"]["listWorkspaceFiles"] = Effect.fn(
    "ArcVcsDriver.listWorkspaceFiles",
  )(function* (cwd) {
    // `ls-files --others` includes ignored files such as node_modules, so untracked paths come from status.
    const [result, changed] = yield* Effect.all([
      execute({
        operation: "ArcVcsDriver.listWorkspaceFiles",
        cwd,
        args: ["ls-files", "--cached", "."],
        maxOutputBytes: MAX_METADATA_BYTES,
      }),
      changedFiles(cwd),
    ]);
    const lines = result.stdout.split("\n");
    if (result.stdoutTruncated) lines.pop();
    const untracked = changed.entries.filter((entry) => entry.untracked).map((entry) => entry.path);
    return {
      paths: [...new Set([...lines, ...untracked].filter(safeRelative))],
      truncated: result.stdoutTruncated,
      freshness: yield* freshness(),
    };
  });
  const filterIgnoredPaths: VcsDriver.VcsDriver["Service"]["filterIgnoredPaths"] = Effect.fn(
    "ArcVcsDriver.filterIgnoredPaths",
  )(function* (cwd, relativePaths) {
    if (relativePaths.length === 0) return [];
    if (!relativePaths.every(safeRelative))
      return yield* invalid(cwd, "filterIgnoredPaths", "File paths must stay within the project.");
    const root = yield* repositoryRoot(cwd);
    const ignored = new Set<string>();
    for (let offset = 0; offset < relativePaths.length; offset += 100) {
      const status = yield* readStatus(cwd, relativePaths.slice(offset, offset + 100), true);
      for (const entry of status.status.ignored ?? []) {
        const relative = projectPath(cwd, root, entry.path);
        if (relative) ignored.add(relative);
      }
    }
    return relativePaths.filter((value) => !ignored.has(value));
  });
  const checkpoints: VcsDriver.VcsCheckpointOps = {
    captureCheckpoint: () => unsupported("captureCheckpoint"),
    hasCheckpointRef: () => unsupported("hasCheckpointRef"),
    restoreCheckpoint: () => unsupported("restoreCheckpoint"),
    diffCheckpoints: () => unsupported("diffCheckpoints"),
    listAuthoredPaths: () => unsupported("listAuthoredPaths"),
    deleteCheckpointRefs: () => unsupported("deleteCheckpointRefs"),
  };
  return {
    execute,
    workingTree,
    detectRepository,
    listWorkspaceFiles,
    filterIgnoredPaths,
    isInsideWorkTree: (cwd: string) =>
      detectRepository(cwd).pipe(Effect.map((repo) => repo !== null)),
    listRemotes: () => freshness().pipe(Effect.map((freshness) => ({ remotes: [], freshness }))),
    initRepository: () => unsupported("initRepository"),
    checkpoints,
    changes: ArcChangeOps.make({ execute, readDiff, safeRelative }),
  } satisfies VcsDriver.VcsDriver["Service"];
});
