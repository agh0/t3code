import { assert, describe, it } from "@effect/vitest";

import { parseChangeRequestUrl } from "../shared/definition.ts";
import {
  arcanumCheck,
  arcanumComments,
  arcanumState,
  checksState,
  reviewDecision,
  watchFingerprint,
} from "./arcanumPullRequests.ts";

describe("change request URLs", () => {
  it("reads Arcanum reviews, whatever page of one is open", () => {
    for (const url of [
      "https://a.yandex-team.ru/review/17050314",
      "https://a.yandex-team.ru/review/17050314/details",
      "https://a.yandex-team.ru/review/17050314/files/40854138?file=a.ts#L3",
    ]) {
      assert.deepStrictEqual(parseChangeRequestUrl(new URL(url)), {
        host: "a.yandex-team.ru",
        repository: "arcadia",
        number: 17050314,
        repositoryUrl: "https://a.yandex-team.ru/arcadia",
      });
    }
    for (const url of [
      "https://a.yandex-team.ru/review",
      "https://a.yandex-team.ru/review/0",
      "https://a.yandex-team.ru/arcadia/review/1",
      "https://a.yandex-team.ru/reviews/1",
      "https://b.yandex-team.ru/review/1",
    ])
      assert.strictEqual(parseChangeRequestUrl(new URL(url)), null, url);
  });
});

const check = (
  system: string,
  type: string,
  status: string,
  extra: { required?: boolean; satisfied?: boolean; system_check_uri?: string } = {},
) => ({ system, type, status, ...extra });

describe("checks", () => {
  it("maps Arcanum statuses, treating optional unknown and unrecognised ones as neutral", () => {
    const statuses = [
      "success",
      "failure",
      "pending",
      "action_required",
      "skipped",
      "unknown",
      "new",
    ].map((status) => arcanumCheck(check("ci", "build", status)).status);
    assert.deepStrictEqual(statuses, [
      "success",
      "failure",
      "pending",
      "action-required",
      "skipped",
      "neutral",
      "neutral",
    ]);
    assert.deepStrictEqual(
      arcanumCheck(
        check("teamcity-browser", "Lint", "success", {
          required: true,
          system_check_uri: "https://teamcity.example/build/1",
        }),
      ),
      {
        name: "teamcity-browser/Lint",
        status: "success",
        description: null,
        url: "https://teamcity.example/build/1",
        required: true,
      },
    );
    assert.strictEqual(arcanumCheck(check("ci", "build", "success")).url, null);
    assert.strictEqual(
      arcanumCheck(check("ci", "build", "unknown", { required: true })).status,
      "action-required",
    );
    assert.strictEqual(
      arcanumCheck(check("ci", "build", "unknown", { required: true, satisfied: true })).status,
      "neutral",
    );
  });

  it("rolls up the required checks, or all of them when none is required", () => {
    const rollup = (...checks: ReturnType<typeof check>[]) => checksState(checks.map(arcanumCheck));
    assert.strictEqual(rollup(), null);
    assert.strictEqual(
      rollup(
        check("ci", "a", "success", { required: true }),
        check("ci", "b", "failure"),
        check("ci", "c", "pending"),
      ),
      "passing",
    );
    assert.strictEqual(
      rollup(
        check("ci", "a", "success", { required: true }),
        check("arcanum", "approved", "pending", { required: true }),
      ),
      "pending",
    );
    assert.strictEqual(
      rollup(
        check("arcanum", "approved", "pending", { required: true }),
        check("arcanum", "comment_issues_closed", "failure", { required: true }),
      ),
      "failing",
    );
    assert.strictEqual(rollup(check("ci", "a", "success"), check("ci", "b", "unknown")), "passing");
    assert.strictEqual(rollup(check("ci", "a", "action_required")), "failing");
  });

  it("reads approval from Arcanum's own approved gate", () => {
    assert.strictEqual(
      reviewDecision([check("arcanum", "approved", "success", { satisfied: true })]),
      "approved",
    );
    assert.strictEqual(
      reviewDecision([
        check("arcanum", "approved", "pending", { satisfied: false }),
        check("arcanum", "[approved] for: team", "success", { satisfied: true }),
      ]),
      "review-required",
    );
  });
});

describe("arcanumState", () => {
  it("tells merged from discarded only for a closed review", () => {
    assert.strictEqual(arcanumState("open", null), "open");
    assert.strictEqual(arcanumState("closed", "merged"), "merged");
    assert.strictEqual(arcanumState("closed", "discarded"), "closed");
  });
});

describe("arcanumComments", () => {
  const anchored = (path: string) => ({ review_request: { diff: { file: { path } } } });
  const comments = arcanumComments([
    {
      id: 1,
      user: { name: "robot-ci" },
      content: "Inline remark",
      created_at: "2026-11-11T00:58:08.696532Z",
      published_at: "2026-11-11T00:58:08.696532Z",
      anchor: anchored("src/a.cc"),
    },
    {
      id: -2,
      user: { name: "viewer" },
      content: "Unpublished",
      created_at: "2026-11-13T08:08:11.977098Z",
      edited_at: "2026-11-13T08:11:44.233151Z",
      draft: true,
      anchor: { review_request: {} },
    },
    {
      id: 3,
      user: { name: "colleague" },
      content: "Reply",
      created_at: "2026-11-13T10:55:00.000000Z",
      published_at: "2026-11-13T10:55:27.823398Z",
      reply_to_id: 1,
    },
    {
      id: 4,
      user: { name: "viewer" },
      content: "Reply to the reply, edited",
      created_at: "2026-11-13T11:38:00.437335Z",
      published_at: "2026-11-13T11:38:00.437335Z",
      edited_at: "2026-11-13T11:40:00.000000Z",
      reply_to_id: 3,
    },
    {
      id: 5,
      user: { name: "colleague" },
      content: "General remark",
      created_at: "2026-11-14T09:00:00.000000Z",
      published_at: "2026-11-14T09:00:00.000000Z",
      anchor: { review_request: {} },
    },
  ]);

  it("skips drafts, and replies take the path of the thread they answer", () => {
    assert.deepStrictEqual(
      comments.map((comment) => [comment.id, comment.kind, comment.path]),
      [
        ["1", "review-comment", "src/a.cc"],
        ["3", "review-comment", "src/a.cc"],
        ["4", "review-comment", "src/a.cc"],
        ["5", "issue-comment", null],
      ],
    );
  });

  it("dates a comment by publication and counts only an edit as one", () => {
    assert.deepStrictEqual(
      comments.map((comment) => [comment.createdAt, comment.editedAt]),
      [
        ["2026-11-11T00:58:08.696532Z", null],
        ["2026-11-13T10:55:27.823398Z", null],
        ["2026-11-13T11:38:00.437335Z", "2026-11-13T11:40:00.000000Z"],
        ["2026-11-14T09:00:00.000000Z", null],
      ],
    );
    assert.deepStrictEqual(comments[0]?.author, {
      login: "robot-ci",
      name: null,
      avatarUrl: null,
      isBot: true,
    });
    assert.strictEqual(comments[1]?.author?.isBot, false);
  });
});

describe("watchFingerprint", () => {
  const review = {
    state: "open",
    updated_at: "2026-11-16T06:42:39.150133Z",
    merge_allowed: false,
    active_diff_set: { id: 40854138 },
    checks: [check("ci", "build", "pending"), check("arcanum", "approved", "pending")],
  };

  it("ignores check order and moves with the diff set, merge gate, checks, and state", () => {
    const base = watchFingerprint(review);
    assert.deepStrictEqual(
      watchFingerprint({ ...review, checks: review.checks.toReversed() }),
      base,
    );
    for (const changed of [
      { ...review, active_diff_set: { id: 40854139 } },
      { ...review, merge_allowed: true },
      { ...review, state: "closed" },
      {
        ...review,
        checks: [check("ci", "build", "success"), check("arcanum", "approved", "pending")],
      },
    ])
      assert.notStrictEqual(watchFingerprint(changed).status, base.status);
    assert.strictEqual(base.remarks, review.updated_at);
  });
});
