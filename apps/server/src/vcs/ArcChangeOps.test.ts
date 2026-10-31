import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/process";
import * as ArcChangeOps from "./ArcChangeOps.ts";
import type * as VcsDriver from "./VcsDriver.ts";
import type * as VcsProcess from "./VcsProcess.ts";

const result = (stdout: string, exitCode = 0, stderr = ""): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(exitCode),
  stdout,
  stderr,
  stdoutTruncated: false,
  stderrTruncated: false,
});

// Shapes copied from `arc info --json --ahead-behind`, `arc info --json --mount` and
// `arc pr status --json` in a real working copy.
const prStatus = {
  id: 16664061,
  url: "https://a.yandex-team.ru/review/16664061",
  author: "tester",
  summary: "BROWSER-1: remove unused methods.",
  status: "draft",
  merge_allowed: false,
  from_branch: "users/tester/topic",
  to_branch: "releases/browser/master",
  updated_at: { seconds: 1793006681, nanos: 893542000 },
};

function fakeArc(info: Record<string, unknown>, respond?: (args: string[]) => string | null) {
  const calls: string[][] = [];
  const execute: VcsDriver.VcsDriver["Service"]["execute"] = (input) => {
    const args = [...input.args];
    calls.push(args);
    const custom = respond?.(args);
    if (custom === "network-failure") return Effect.succeed(result("", 1, "[FAIL] timeout\n"));
    if (custom === "not-found")
      return Effect.succeed(result("", 1, "[FAIL] Can't find any PR with id\n"));
    if (custom !== null && custom !== undefined) return Effect.succeed(result(custom));
    if (args[0] === "info" && args.includes("--mount"))
      return Effect.succeed(result(JSON.stringify({ default_branch: "trunk" })));
    if (args[0] === "info") return Effect.succeed(result(JSON.stringify(info)));
    return Effect.succeed(result(""));
  };
  const changes = ArcChangeOps.make({
    execute,
    readDiff: () => Effect.succeed({ diff: "", files: [] }),
    safeRelative: () => true,
  });
  return { changes, calls };
}

describe("ArcChangeOps", () => {
  it.effect("reads a published branch's counts and pull request into remote status", () =>
    Effect.gen(function* () {
      const { changes, calls } = fakeArc(
        { branch: "topic", remote: "users/tester/topic", counts: { ahead: 2, behind: 1 } },
        (args) => (args[0] === "pr" ? JSON.stringify(prStatus) : null),
      );
      assert.deepEqual(yield* changes.remoteStatus("/repo"), {
        hasUpstream: true,
        aheadCount: 2,
        behindCount: 1,
        pr: {
          number: 16664061,
          title: "BROWSER-1: remove unused methods.",
          url: "https://a.yandex-team.ru/review/16664061",
          baseRef: "releases/browser/master",
          headRef: "users/tester/topic",
          state: "open",
          isDraft: true,
          updatedAt: "2026-10-26T09:24:41.000Z",
        },
      });
      assert.deepEqual(
        calls.find((args) => args[0] === "pr"),
        ["pr", "status", "--json", "users/tester/topic"],
      );
    }),
  );

  it.effect("treats a tracked shared branch as the base, not as the upstream", () =>
    Effect.gen(function* () {
      const { changes, calls } = fakeArc({
        branch: "topic",
        remote: "releases/browser/master",
        counts: { ahead: 1, behind: 729 },
      });
      assert.deepEqual(yield* changes.branchState("/repo"), {
        branch: "topic",
        defaultBranch: "trunk",
        upstream: null,
        baseRef: "releases/browser/master",
        aheadCount: 1,
        behindCount: 0,
      });
      assert.deepEqual(yield* changes.remoteStatus("/repo"), {
        hasUpstream: false,
        aheadCount: 1,
        behindCount: 0,
        pr: null,
      });
      assert.ok(calls.every((args) => args[0] !== "pr"));
    }),
  );

  it.effect("counts commits ahead of the default branch when nothing is tracked", () =>
    Effect.gen(function* () {
      const { changes, calls } = fakeArc({ branch: "topic" }, (args) =>
        args[0] === "log" ? JSON.stringify([{ commit: "a" }, { commit: "b" }]) : null,
      );
      assert.equal((yield* changes.branchState("/repo")).aheadCount, 2);
      assert.deepEqual(
        calls.find((args) => args[0] === "log"),
        ["log", "--json", "-n", "100", "trunk..HEAD"],
      );
    }),
  );

  it.effect("reports no pull request when Arc has none or cannot be reached", () =>
    Effect.gen(function* () {
      const info = { branch: "topic", remote: "users/tester/topic" };
      const missing = fakeArc(info, (args) => (args[0] === "pr" ? "not-found" : null));
      assert.equal(yield* missing.changes.findChangeRequest("/repo", "users/tester/topic"), null);
      const offline = fakeArc(info, (args) => (args[0] === "pr" ? "network-failure" : null));
      const error = yield* offline.changes
        .findChangeRequest("/repo", "users/tester/topic")
        .pipe(Effect.flip);
      assert.equal(error._tag, "VcsProcessExitError");
      assert.equal((yield* offline.changes.remoteStatus("/repo")).pr, null);
    }),
  );

  it.effect("never pushes the default branch or a tracked shared branch", () =>
    Effect.gen(function* () {
      const trunk = fakeArc({ branch: "trunk", remote: "trunk", user_login: "tester" });
      const error = yield* trunk.changes.push("/repo").pipe(Effect.flip);
      assert.equal(error._tag, "VcsUnsupportedOperationError");
      assert.ok(trunk.calls.every((args) => args[0] !== "push"));

      const release = fakeArc({
        branch: "topic",
        remote: "releases/browser/master",
        user_login: "tester",
      });
      assert.deepEqual(yield* release.changes.push("/repo"), {
        upstream: "users/tester/topic",
        setUpstream: true,
      });
      assert.deepEqual(
        release.calls.find((args) => args[0] === "push"),
        ["push", "--set-upstream", "users/tester/topic"],
      );
    }),
  );
});
