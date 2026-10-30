import { createTwoFilesPatch, parsePatch } from "diff";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { VcsRepositoryDetectionError, VcsUnsupportedOperationError } from "@t3tools/contracts";
import type { ReviewDiffFileStat, VcsError } from "@t3tools/contracts";
import { quoteGitPatchPath, unquoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const Entry = Schema.Struct({ path: Schema.String, status: Schema.String, type: Schema.String });
const Status = Schema.Struct({
  branch_info: Schema.optional(
    Schema.Struct({ local: Schema.optional(Schema.Struct({ name: Schema.String })) }),
  ),
  status: Schema.Record(Schema.String, Schema.Array(Entry)),
});
const decodeStatus = Schema.decodeEffect(Schema.fromJsonString(Status));
const decodeInfo = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ branch: Schema.optional(Schema.String) })),
);

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const process = yield* VcsProcess.VcsProcess;
  const crypto = yield* Crypto.Crypto;
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
        detail: "Arc currently supports reading the existing working copy only.",
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
  const currentBranch = Effect.fn("ArcVcsDriver.currentBranch")(function* (cwd: string) {
    const result = yield* execute({
      operation: "ArcVcsDriver.currentBranch",
      cwd,
      args: ["info", "--json"],
      maxOutputBytes: 64 * 1024,
    });
    if (result.stdoutTruncated)
      return yield* invalid(
        cwd,
        "currentBranch",
        "Arc branch metadata exceeds the response limit.",
      );
    const info = yield* decodeInfo(result.stdout).pipe(
      Effect.mapError((cause) =>
        invalid(cwd, "currentBranch", "Arc returned invalid branch metadata.", cause),
      ),
    );
    return info.branch || null;
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

  const readDiff = Effect.fn("ArcVcsDriver.readDiff")(function* (
    cwd: string,
    file?: { path: string; previousPath: string | null },
    ignoreWhitespace = false,
  ) {
    const changed = yield* changedFiles(cwd);
    const selected = file ? [file.path, ...(file.previousPath ? [file.previousPath] : [])] : ["."];
    if (file && selected.some((name) => !safeRelative(name)))
      return yield* invalid(cwd, "readDiff", "File paths must stay within the project.");
    const result = yield* execute({
      operation: "ArcVcsDriver.readDiff",
      cwd,
      args: [
        "diff",
        "--git",
        "--no-color",
        "--relative=.",
        ...(ignoreWhitespace ? ["--ignore-all-space"] : []),
        "HEAD",
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
    for (const entry of changed.entries) {
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
    const files = changed.entries
      .filter((entry) => !file || selected.includes(entry.path))
      .map(
        (entry) =>
          stats.get(entry.path) ?? {
            path: entry.path,
            previousPath: null,
            additions: 0,
            deletions: 0,
          },
      );
    return { diff, files, truncated, branch: changed.branch };
  });

  const workingTree: VcsDriver.VcsWorkingTreeOps = {
    currentBranch,
    localStatus: Effect.fn("ArcVcsDriver.localStatus")(function* ({ cwd }) {
      const result = yield* readDiff(cwd);
      const files = result.files.map((file) => ({
        path: file.path,
        insertions: file.additions,
        deletions: file.deletions,
      }));
      return {
        isRepo: true,
        supportsMutations: false,
        hasPrimaryRemote: false,
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
        hasPrimaryRemote: false,
        refs,
        totalCount: refs.length,
        nextCursor: null,
      };
    }),
    getDiffPreview: Effect.fn("ArcVcsDriver.getDiffPreview")(function* (input) {
      if (input.commitSha || (input.file && input.file.sourceKind !== "working-tree"))
        return yield* unsupported("getDiffPreview");
      const result = yield* readDiff(input.cwd, input.file, input.ignoreWhitespace);
      const hash = yield* crypto
        .digest(
          "SHA-256",
          new TextEncoder().encode(
            result.diff + "\0" + result.files.map((file) => file.path).join("\0"),
          ),
        )
        .pipe(
          Effect.map(Hex.encode),
          Effect.mapError((cause) =>
            invalid(input.cwd, "getDiffPreview", "Failed to hash Arc diff.", cause),
          ),
        );
      return {
        cwd: input.cwd,
        generatedAt: yield* DateTime.now,
        sources: [
          {
            id: "working-tree",
            kind: "working-tree",
            title: "Uncommitted",
            baseRef: "HEAD",
            headRef: null,
            diff: result.diff,
            files: result.files,
            diffHash: hash,
            truncated: result.truncated,
          },
        ],
      };
    }),
    getDiffFileContents: Effect.fn("ArcVcsDriver.getDiffFileContents")(function* (input) {
      if (
        input.sourceKind !== "working-tree" ||
        input.headRef !== null ||
        (input.baseRef !== null && input.baseRef !== "HEAD")
      )
        return yield* unsupported("getDiffFileContents");
      if (![input.oldPath, input.newPath].every(safeRelative))
        return yield* invalid(
          input.cwd,
          "getDiffFileContents",
          "File paths must stay within the project.",
        );
      const root = yield* repositoryRoot(input.cwd);
      let oldContents = "";
      if (input.changeType !== "new") {
        const relative = path
          .relative(root, path.resolve(input.cwd, input.oldPath))
          .split(path.sep)
          .join("/");
        const result = yield* execute({
          operation: "ArcVcsDriver.getDiffFileContents",
          cwd: input.cwd,
          args: ["show", `HEAD:${relative}`],
          maxOutputBytes: MAX_FILE_BYTES,
        });
        if (result.stdoutTruncated || result.stdout.includes("\0"))
          return yield* invalid(
            input.cwd,
            "getDiffFileContents",
            "File contents exceed the text preview limit.",
          );
        oldContents = result.stdout;
      }
      const current =
        input.changeType === "deleted"
          ? { kind: "text" as const, text: "" }
          : yield* readFile(input.cwd, input.newPath);
      if (current.kind !== "text")
        return yield* invalid(
          input.cwd,
          "getDiffFileContents",
          "File contents exceed the text preview limit.",
        );
      return { oldContents, newContents: current.text };
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
  } satisfies VcsDriver.VcsDriver["Service"];
});
