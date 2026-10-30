import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import { CheckpointRef } from "@t3tools/contracts";
import * as ArcVcsDriver from "./ArcVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

const output = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

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
  const responses = {
    diff: output(patch),
    status: output(""),
    files: output("tracked.txt\n../outside\n.arc/config\n"),
  };
  const calls: VcsProcess.VcsProcessInput[] = [];
  const process = VcsProcess.VcsProcess.of({
    run: (input) => {
      calls.push(input);
      assert.equal(input.command, "arc");
      switch (input.args[0]) {
        case "info":
          return Effect.succeed(output(JSON.stringify({ branch: "users/test/topic" })));
        case "root":
          return Effect.succeed(output(`${root}\n`));
        case "status":
          return Effect.succeed({
            ...responses.status,
            stdout: responses.status.stdout || JSON.stringify(status),
          });
        case "diff":
          return Effect.succeed(responses.diff);
        case "ls-files":
          return Effect.succeed(responses.files);
        case "show":
          return Effect.succeed(output("old\n"));
        default:
          return Effect.die(`Unexpected Arc command: ${input.args[0]}`);
      }
    },
  });
  const driver = yield* ArcVcsDriver.make.pipe(
    Effect.provideService(VcsProcess.VcsProcess, process),
  );
  return { driver, root, cwd, calls, fs, path, status, responses };
});

describe("ArcVcsDriver", () => {
  it.effect("detects Arc and scopes staged, unstaged and untracked changes to the project", () =>
    Effect.gen(function* () {
      const { driver, root, cwd, calls } = yield* fixture();
      assert.equal((yield* driver.detectRepository(cwd))?.rootPath, root);
      const status = yield* driver.workingTree.localStatus({ cwd });
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
        assert.equal(result.sources.length, 1);
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
        assert.equal(error._tag, "VcsUnsupportedOperationError");
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
});
