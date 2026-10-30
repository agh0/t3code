import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/process";
import * as Layer from "effect/Layer";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";

import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

it.layer(NodeServices.layer)("GitWorkflowService", (it) => {
  it.effect("finds a name among the refs of every namespace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ref-named-" });
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      for (const args of [
        ["init", "-b", "main"],
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
        ["update-ref", "refs/remotes/upstream/feature/topic", "HEAD"],
        ["symbolic-ref", "refs/remotes/origin/alias", "refs/heads/main"],
        ["update-ref", "refs/mirror/origin/mirrored", "HEAD"],
      ]) {
        yield* driver.execute({ operation: "test.setupRepo", cwd, args });
      }
      const found = yield* Effect.forEach(
        ["main", "feature/topic", "alias", "mirrored", "t3/renamed", "feature/*"],
        (refName) => workflow.hasRefNamed({ cwd, refName }),
      );
      assert.deepEqual(found, [true, true, true, true, false, false]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
              resolve: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
            }),
          ),
          Layer.provide(Layer.mock(GitManager.GitManager)({})),
          Layer.provideMerge(GitVcsDriver.layer),
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-ref-named-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});

it.effect("routes Arc reads without Git and refuses Git mutations in an Arc working copy", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-arc-workflow-" });
    yield* fs.makeDirectory(`${cwd}/.arc`);
    const process = VcsProcess.VcsProcess.of({
      run: (input) => {
        assert.equal(input.command, "arc");
        const stdout =
          input.args[0] === "status"
            ? '{"branch_info":{"local":{"name":"users/test/topic"}},"status":{}}'
            : input.args[0] === "info"
              ? '{"branch":"users/test/topic"}'
              : "";
        return Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout,
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      },
    });
    yield* Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      assert.equal((yield* workflow.status({ cwd })).supportsMutations, false);
      assert.equal(yield* workflow.currentBranch(cwd), "users/test/topic");
      assert.equal((yield* workflow.listRefs({ cwd })).refs[0]?.name, "users/test/topic");
      assert.equal(yield* workflow.remoteStatus({ cwd }), null);
      for (const action of [
        workflow.pullCurrentBranch(cwd).pipe(Effect.asVoid),
        workflow.createRef({ cwd, refName: "new" }).pipe(Effect.asVoid),
        workflow.switchRef({ cwd, refName: "trunk" }).pipe(Effect.asVoid),
        workflow.createWorktree({ cwd, refName: "trunk", path: null }).pipe(Effect.asVoid),
      ]) {
        const error = yield* action.pipe(Effect.flip);
        assert.equal(error._tag, "GitCommandError");
        assert.match(error.detail ?? "", /requires Git/);
      }
    }).pipe(
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(Layer.mock(GitManager.GitManager)({})),
          Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
          Layer.provide(VcsDriverRegistry.layer),
          Layer.provide(Layer.succeed(VcsProcess.VcsProcess, process)),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
