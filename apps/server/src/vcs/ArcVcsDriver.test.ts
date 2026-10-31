import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";
import {
  CheckpointRef,
  VcsProcessExitError,
  VcsProcessSpawnError,
  VcsProcessTimeoutError,
  type VcsError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ArcVcsDriver from "./ArcVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

const output = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const HEAD = "1".repeat(40);
const BASE = "b".repeat(40);
const PARENT = "a".repeat(40);
const COMMIT = "c".repeat(40);
const logEntry = (commit: string, message: string) =>
  JSON.stringify({ commit, parents: [PARENT], date: "2026-10-21T10:56:32+03:00", message });

const fixture = Effect.fn("test.arcFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-arc-" });
  const cwd = path.join(root, "browser", "client");
  yield* fs.makeDirectory(path.join(root, ".arc"));
  yield* fs.makeDirectory(cwd, { recursive: true });
  yield* fs.writeFileString(path.join(cwd, "new file.txt"), "new\nfile\n");
  const status = {
    branch_info: { local: { name: "users/test/topic" } },
    status: {
      changed: [
        { path: "browser/client/tracked.txt", status: "modified", type: "file" },
        { path: "elsewhere.txt", status: "modified", type: "file" },
      ],
      staged: [{ path: "browser/client/staged.txt", status: "added", type: "file" }],
      untracked: [{ path: "browser/client/new file.txt", status: "untracked", type: "file" }],
    },
  };
  const patch =
    "diff --git a/tracked.txt b/tracked.txt\n--- a/tracked.txt\n+++ b/tracked.txt\n@@ -1 +1 @@\n-old\n+new\n";
  // nativefs copies have no mount counter.
  const counter: Effect.Effect<VcsProcess.VcsProcessOutput, VcsError> = Effect.succeed({
    ...output(""),
    exitCode: ChildProcessSpawner.ExitCode(1),
  });
  const responses: {
    counter: Effect.Effect<VcsProcess.VcsProcessOutput, VcsError>;
    info: string;
    diff: VcsProcess.VcsProcessOutput;
    status: VcsProcess.VcsProcessOutput;
    files: VcsProcess.VcsProcessOutput;
    mergeBase: Effect.Effect<VcsProcess.VcsProcessOutput, VcsError>;
    log: VcsProcess.VcsProcessOutput;
  } = {
    counter,
    info: JSON.stringify({ branch: "users/test/topic", hash: "head" }),
    mergeBase: Effect.succeed(output(JSON.stringify({ base: BASE, ahead: 2, behind: 0 }))),
    log: output(`${logEntry(COMMIT, "Second\n\nBody")}\n${logEntry(PARENT, "First")}\n`),
    diff: output(patch),
    status: output(""),
    files: output("tracked.txt\n../outside\n.arc/config\n"),
  };
  const calls: VcsProcess.VcsProcessInput[] = [];
  const process = VcsProcess.VcsProcess.of({
    run: (input) => {
      calls.push(input);
      if (input.command === "/usr/bin/xattr") return responses.counter;
      assert.equal(input.command, "arc");
      switch (input.args[0]) {
        case "info":
          return Effect.succeed(
            output(
              JSON.stringify(
                input.args.includes("--mount")
                  ? { repository: "arcadia", default_branch: "trunk" }
                  : JSON.parse(responses.info),
              ),
            ),
          );
        case "rev-parse":
          return Effect.succeed(output(`${HEAD}\n`));
        case "merge-base":
          return responses.mergeBase;
        case "log":
          return Effect.succeed(
            input.args.includes("--no-walk")
              ? output(`[${logEntry(input.args.at(-1)!, "Fix the thing\n\nDetails")}]`)
              : responses.log,
          );
        case "root":
          return Effect.succeed(output(`${root}\n`));
        case "status":
          return Effect.succeed({
            ...responses.status,
            stdout: responses.status.stdout || JSON.stringify(status),
          });
        case "diff":
          return Effect.succeed(
            input.args.includes("--name-status")
              ? output(
                  JSON.stringify([
                    { names: [{ path: "tracked.txt" }, { path: "listed.txt" }, { path: "../up" }] },
                  ]),
                )
              : responses.diff,
          );
        case "ls-files":
          return Effect.succeed(responses.files);
        case "show":
          return Effect.succeed(output(`${input.args[1]}\n`));
        default:
          return Effect.die(`Unexpected Arc command: ${input.args[0]}`);
      }
    },
  });
  const driver = yield* ArcVcsDriver.make.pipe(
    Effect.provideService(VcsProcess.VcsProcess, process),
    Effect.provideService(HostProcess.Platform, "darwin"),
  );
  return { driver, root, cwd, calls, fs, path, status, responses };
});

describe("ArcVcsDriver", () => {
  it.effect("detects Arc and scopes staged, unstaged and untracked changes to the project", () =>
    Effect.gen(function* () {
      const { driver, root, cwd, calls } = yield* fixture();
      assert.equal((yield* driver.detectRepository(cwd))?.rootPath, root);
      const status = yield* driver.workingTree.localStatus({ cwd });
      assert.equal(calls.find((call) => call.args[0] === "status")?.timeoutMs, 120_000);
      assert.equal(status.refName, "users/test/topic");
      assert.equal(status.supportsMutations, false);
      assert.equal(status.workingTree.rootPath, cwd);
      assert.deepEqual(status.workingTree.files.map((file) => file.path).sort(), [
        "new file.txt",
        "staged.txt",
        "tracked.txt",
      ]);
      assert.equal(status.workingTree.insertions, 3);
      assert.equal(status.workingTree.deletions, 1);
      assert.ok(
        calls.some(
          (call) =>
            call.args[0] === "diff" &&
            call.args.includes("HEAD") &&
            call.args.includes("--relative=."),
        ),
      );
      const files = yield* driver.listWorkspaceFiles(cwd);
      assert.deepEqual(files.paths, ["tracked.txt", "new file.txt"]);
      assert.ok(
        calls.every((call) => call.args[0] !== "ls-files" || !call.args.includes("--others")),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "includes untracked text in review without touching the index and reads original contents from Arc",
    () =>
      Effect.gen(function* () {
        const { driver, cwd, calls } = yield* fixture();
        const result = yield* driver.workingTree.getDiffPreview({ cwd });
        assert.equal(result.sources[0]!.kind, "working-tree");
        assert.match(result.sources[0]!.diff, /new file mode/);
        assert.match(result.sources[0]!.diff, /\+new\n\+file/);
        assert.equal(result.sources[0]!.files?.length, 3);
        const contents = yield* driver.workingTree.getDiffFileContents({
          cwd,
          sourceKind: "working-tree",
          changeType: "new",
          baseRef: "HEAD",
          headRef: null,
          oldPath: "new file.txt",
          newPath: "new file.txt",
        });
        assert.deepEqual(contents, { oldContents: "", newContents: "new\nfile\n" });
        assert.ok(
          calls.every(
            (call) => !["add", "reset", "stash", "checkout"].includes(call.args[0] ?? ""),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "rejects paths outside the project, including symlinks, and unsupported review sources",
    () =>
      Effect.gen(function* () {
        const { driver, root, cwd, fs, path, status } = yield* fixture();
        yield* fs.writeFileString(path.join(root, "secret"), "secret\n");
        yield* fs.symlink(path.join(root, "secret"), path.join(cwd, "link"));
        yield* fs.symlink(path.join(root, "missing"), path.join(cwd, "broken"));
        status.status.untracked.push(
          { path: "browser/client/link", status: "untracked", type: "file" },
          { path: "browser/client/broken", status: "untracked", type: "file" },
        );
        const local = yield* driver.workingTree.localStatus({ cwd });
        assert.ok(local.workingTree.files.some((file) => file.path === "link"));
        assert.ok(local.workingTree.files.some((file) => file.path === "broken"));
        assert.ok(local.workingTree.files.some((file) => file.path === "new file.txt"));
        for (const filePath of ["../secret", "/etc/passwd", "link"]) {
          const error = yield* driver.workingTree
            .getDiffFileContents({
              cwd,
              sourceKind: "working-tree",
              changeType: "new",
              baseRef: "HEAD",
              headRef: null,
              oldPath: filePath,
              newPath: filePath,
            })
            .pipe(Effect.flip);
          assert.equal(error._tag, "VcsRepositoryDetectionError");
        }
        const error = yield* driver.workingTree
          .getDiffPreview({ cwd, commitSha: "abc" })
          .pipe(Effect.flip);
        assert.equal(error._tag, "VcsRepositoryDetectionError");
        assert.equal(
          (yield* driver.checkpoints
            .captureCheckpoint({ cwd, checkpointRef: CheckpointRef.make("unused") })
            .pipe(Effect.flip))._tag,
          "VcsUnsupportedOperationError",
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect(
    "bounds incomplete patch and metadata output without treating it as a complete preview",
    () =>
      Effect.gen(function* () {
        const { driver, cwd, responses } = yield* fixture();
        responses.diff = {
          ...responses.diff,
          stdout: responses.diff.stdout.slice(0, -5),
          stdoutTruncated: true,
        };
        const preview = yield* driver.workingTree.getDiffPreview({ cwd });
        assert.equal(preview.sources[0]?.truncated, true);
        // A truncated range patch takes its complete file list from Arc's name-status.
        assert.equal(preview.sources[1]?.truncated, true);
        assert.deepEqual(preview.sources[1]?.files?.map((file) => file.path).sort(), [
          "listed.txt",
          "new file.txt",
          "tracked.txt",
        ]);
        responses.status = { ...responses.status, stdoutTruncated: true };
        assert.equal(
          (yield* driver.workingTree.localStatus({ cwd }).pipe(Effect.flip))._tag,
          "VcsRepositoryDetectionError",
        );
        responses.status = { ...responses.status, stdoutTruncated: false };
        responses.files = {
          ...responses.files,
          stdout: "complete.txt\npartial",
          stdoutTruncated: true,
        };
        const files = yield* driver.listWorkspaceFiles(cwd);
        assert.deepEqual(files.paths, ["complete.txt", "new file.txt"]);
        assert.equal(files.truncated, true);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reruns Arc status only when the mount counter or arc info changes", () =>
    Effect.gen(function* () {
      const { driver, root, cwd, calls, responses } = yield* fixture();
      const runs = (command: string) => calls.filter((call) => call.args[0] === command).length;
      const localStatus = driver.workingTree.localStatus({ cwd });

      yield* localStatus;
      yield* localStatus;
      assert.equal(runs("status"), 2);
      assert.equal(runs("info"), 0);

      responses.counter = Effect.succeed(output("7\n"));
      yield* localStatus;
      yield* localStatus;
      yield* driver.workingTree.getDiffPreview({ cwd });
      assert.equal(runs("status"), 3);
      assert.equal(runs("diff"), 3);
      assert.deepEqual(calls.find((call) => call.command === "/usr/bin/xattr")?.args, [
        "-p",
        "user.arc.get.counter",
        root,
      ]);

      responses.counter = Effect.succeed(output("8\n"));
      yield* localStatus;
      assert.equal(runs("status"), 4);

      responses.info = JSON.stringify({ branch: "users/test/topic", hash: "next" });
      yield* localStatus;
      assert.equal(runs("status"), 5);

      yield* TestClock.adjust(Duration.minutes(1));
      yield* localStatus;
      assert.equal(runs("status"), 6);

      responses.counter = Effect.fail(
        new VcsProcessSpawnError({
          operation: "test",
          command: "/usr/bin/xattr",
          cwd,
          cause: "missing",
        }),
      );
      yield* localStatus;
      yield* localStatus;
      assert.equal(runs("status"), 8);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "compares the branch from its trunk merge-base to the working copy and reads both sides",
    () =>
      Effect.gen(function* () {
        const { driver, cwd, calls } = yield* fixture();
        const preview = yield* driver.workingTree.getDiffPreview({ cwd });
        assert.deepEqual(
          preview.sources.map((source) => source.kind),
          ["working-tree", "branch-range"],
        );
        const branch = preview.sources[1]!;
        assert.equal(branch.title, "Changes vs arcadia/trunk");
        assert.equal(branch.baseRef, "arcadia/trunk");
        assert.equal(branch.headRef, "users/test/topic");
        assert.match(branch.diff, /new file mode/);
        assert.deepEqual(branch.files?.map((file) => file.path).sort(), [
          "new file.txt",
          "tracked.txt",
        ]);
        assert.ok(
          calls.some(
            (call) =>
              call.args.join(" ") === `merge-base --json --leftmost arcadia/trunk HEAD` &&
              call.timeoutMs === 15_000,
          ),
        );
        assert.ok(
          calls.some(
            (call) =>
              call.args[0] === "diff" &&
              call.args.includes(BASE) &&
              call.args.includes("--relative=.") &&
              !call.args.includes("HEAD"),
          ),
        );
        assert.equal(calls.filter((call) => call.args[0] === "status").length, 1);

        const contents = yield* driver.workingTree.getDiffFileContents({
          cwd,
          sourceKind: "branch-range",
          changeType: "change",
          baseRef: branch.baseRef,
          headRef: branch.headRef,
          oldPath: "new file.txt",
          newPath: "new file.txt",
        });
        assert.deepEqual(contents, {
          oldContents: `${BASE}:browser/client/new file.txt\n`,
          newContents: "new\nfile\n",
        });
        assert.equal(calls.filter((call) => call.args[0] === "merge-base").length, 1);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("shows a single commit against its first parent without reading the working copy", () =>
    Effect.gen(function* () {
      const { driver, cwd, calls } = yield* fixture();
      const preview = yield* driver.workingTree.getDiffPreview({ cwd, commitSha: COMMIT });
      const [source] = preview.sources;
      assert.equal(preview.sources.length, 1);
      assert.equal(source?.kind, "commit");
      assert.equal(source?.id, COMMIT);
      assert.equal(source?.title, "Commit ccccccc");
      assert.equal(source?.commitSubject, "Fix the thing");
      assert.equal(source?.baseRef, PARENT);
      assert.equal(source?.headRef, COMMIT);
      assert.deepEqual(
        source?.files?.map((file) => file.path),
        ["tracked.txt"],
      );
      assert.notMatch(source!.diff, /new file mode/);
      assert.ok(calls.every((call) => call.args[0] !== "status"));
      const diff = calls.find((call) => call.args[0] === "diff")!;
      assert.deepEqual(diff.args.slice(-4), [PARENT, COMMIT, "--", "."]);

      const contents = yield* driver.workingTree.getDiffFileContents({
        cwd,
        sourceKind: "commit",
        changeType: "change",
        baseRef: PARENT,
        headRef: COMMIT,
        oldPath: "tracked.txt",
        newPath: "tracked.txt",
      });
      assert.deepEqual(contents, {
        oldContents: `${PARENT}:browser/client/tracked.txt\n`,
        newContents: `${COMMIT}:browser/client/tracked.txt\n`,
      });
      const stale = yield* driver.workingTree
        .getDiffFileContents({
          cwd,
          sourceKind: "commit",
          changeType: "change",
          baseRef: BASE,
          headRef: COMMIT,
          oldPath: "tracked.txt",
          newPath: "tracked.txt",
        })
        .pipe(Effect.flip);
      assert.equal(stale._tag, "VcsRepositoryDetectionError");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "lists branch commits after the merge-base, keeping complete lines when truncated",
    () =>
      Effect.gen(function* () {
        const { driver, cwd, calls, responses } = yield* fixture();
        const result = yield* driver.workingTree.getBranchCommits({ cwd });
        assert.deepEqual(result, {
          commits: [
            { sha: COMMIT, subject: "Second", committedAt: "2026-10-21T10:56:32+03:00" },
            { sha: PARENT, subject: "First", committedAt: "2026-10-21T10:56:32+03:00" },
          ],
          truncated: false,
        });
        assert.deepEqual(calls.find((call) => call.args[0] === "log")?.args, [
          "log",
          "--json-lines",
          "-n",
          "101",
          `${BASE}..HEAD`,
        ]);
        responses.log = {
          ...responses.log,
          stdout: `${logEntry(COMMIT, "Second")}\n{"commit":"`,
          stdoutTruncated: true,
        };
        const truncated = yield* driver.workingTree.getBranchCommits({ cwd });
        assert.deepEqual(
          truncated.commits.map((commit) => commit.sha),
          [COMMIT],
        );
        assert.equal(truncated.truncated, true);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("omits the branch range and commits when Arc cannot resolve the merge-base", () =>
    Effect.gen(function* () {
      const { driver, cwd, calls, responses } = yield* fixture();
      responses.mergeBase = Effect.fail(
        new VcsProcessExitError({
          operation: "ArcVcsDriver.resolveBase",
          command: "arc",
          cwd,
          exitCode: 1,
          detail: "unknown reference",
        }),
      );
      const preview = yield* driver.workingTree.getDiffPreview({ cwd });
      assert.deepEqual(
        preview.sources.map((source) => source.kind),
        ["working-tree"],
      );
      assert.deepEqual(yield* driver.workingTree.getBranchCommits({ cwd }), {
        commits: [],
        truncated: false,
      });
      // A failed lookup is not cached, so the next request asks Arc again.
      assert.equal(calls.filter((call) => call.args[0] === "merge-base").length, 2);
      assert.ok(calls.every((call) => call.args[0] !== "log"));
      // A timeout is remembered for this HEAD, so a slow merge-base does not stall every refresh.
      responses.mergeBase = Effect.fail(
        new VcsProcessTimeoutError({
          operation: "ArcVcsDriver.resolveBase",
          command: "arc",
          cwd,
          timeoutMs: 15_000,
        }),
      );
      yield* driver.workingTree.getBranchCommits({ cwd });
      yield* driver.workingTree.getDiffPreview({ cwd });
      assert.equal(calls.filter((call) => call.args[0] === "merge-base").length, 3);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
