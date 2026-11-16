import * as Effect from "effect/Effect";
import type { PullRequestCapabilities, PullRequestViewerPermissions } from "@t3tools/contracts";
import {
  PullRequestProviderError,
  type ProviderChangeRequestDetail,
  type ProviderRepositoryRef,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";

import { definition } from "../shared/definition.ts";

import * as ArcanumApi from "./ArcanumApi.ts";
import {
  arcanumActor,
  arcanumCheck,
  arcanumComments,
  arcanumState,
  checksState,
  CommentListSchema,
  FINGERPRINT_FIELDS,
  PullRequestStatusSchema,
  REVIEW_REQUEST_FIELDS,
  reviewDecision,
  ReviewRequestSchema,
  watchFingerprint,
} from "./arcanumPullRequests.ts";

const CAPABILITIES: PullRequestCapabilities = {
  diff: false,
  comment: false,
  actions: [],
  mergeMethods: [],
  search: false,
  review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
  reviewers: { request: false, listCandidates: false },
  checksAlwaysReport: true,
};

const VIEWER_PERMISSIONS: PullRequestViewerPermissions = {
  actions: [],
  comment: false,
  resolve: false,
  verdicts: [],
  requestReviewers: false,
};

const unsupported = (operation: string) =>
  Effect.fail(
    new PullRequestProviderError({
      provider: definition.kind,
      operation,
      reason: "failed",
      detail: "Arcanum pull requests are read-only in T3 Code.",
    }),
  );

type ChangeRequestRef = ProviderRepositoryRef & { readonly number: number };

const reviewPath = (number: number, suffix = "") => `/api/v1/review-requests/${number}${suffix}`;

export const make = Effect.gen(function* () {
  const api = yield* ArcanumApi.ArcanumApi;

  const readDetail = Effect.fn("ArcanumPullRequestProvider.readDetail")(function* (
    input: ChangeRequestRef,
  ) {
    const { data: review } = yield* api.get(
      {
        operation: "getChangeRequest",
        path: `${reviewPath(input.number)}?fields=${REVIEW_REQUEST_FIELDS}`,
      },
      ReviewRequestSchema,
    );
    const status =
      review.state === "closed"
        ? (yield* api.get(
            {
              operation: "getChangeRequest",
              path: `/api/v1/pull-requests/${input.number}?fields=status`,
            },
            PullRequestStatusSchema,
          )).data.status
        : null;
    const state = arcanumState(review.state, status);
    const checks = (review.checks ?? []).map(arcanumCheck);
    const closedAt = state === "open" ? null : review.closed_at?.trim() || null;
    const updatedAt =
      review.updated_at?.trim() || review.created_at?.trim() || "1970-01-01T00:00:00.000Z";
    const detail: ProviderChangeRequestDetail = {
      number: input.number,
      title: review.summary?.trim() || `Review ${input.number}`,
      url: definition.changeRequestUrl(input),
      author: arcanumActor(review.author?.name),
      headBranch: review.vcs?.from_branch ?? "",
      baseBranch: review.vcs?.to_branch ?? "",
      state,
      isDraft: false,
      // Arcanum reports no conflict check.
      mergeability: "unknown",
      additions: review.active_diff_set?.patch_stats?.additions ?? 0,
      deletions: review.active_diff_set?.patch_stats?.deletions ?? 0,
      createdAt: review.created_at?.trim() || updatedAt,
      closedAt,
      mergedAt: state === "merged" ? closedAt : null,
      updatedAt,
      reviewRequestLogins: [],
      labels: (review.labels ?? []).flatMap((label) => {
        const name = label.name?.trim();
        return name ? [{ name, color: null }] : [];
      }),
      reviewDecision: reviewDecision(review.checks ?? []),
      checksState: checksState(checks),
      // There is no head commit; the diff set changes on every push, which is what a head is for.
      headSha: review.active_diff_set ? String(review.active_diff_set.id) : null,
      body: review.description ?? "",
      changedFiles: 0,
      reviewers: (review.reviewers ?? []).flatMap((reviewer) => {
        const actor = arcanumActor(reviewer.user?.name);
        return actor ? [actor] : [];
      }),
      checks,
      mergeCapabilities: { merge: false, squash: false, rebase: false },
      viewerPermissions: VIEWER_PERMISSIONS,
    };
    return detail;
  });

  const provider: PullRequestProviderApi = {
    kind: definition.kind,
    capabilities: CAPABILITIES,
    readsPublicHostWithoutCheckout: true,

    getViewer: () => api.viewer(),

    getChangeRequest: readDetail,

    getChangeRequestSummary: (input) =>
      readDetail(input).pipe(
        Effect.map((detail) => ({
          number: detail.number,
          title: detail.title,
          url: detail.url,
          headBranch: detail.headBranch,
          baseBranch: detail.baseBranch,
          state: detail.state,
          closedAt: detail.closedAt,
          mergedAt: detail.mergedAt,
          updatedAt: detail.updatedAt,
          author: detail.author,
          additions: detail.additions,
          deletions: detail.deletions,
          reviewDecision: detail.reviewDecision,
          checksState: detail.checksState,
          mergeability: detail.mergeability,
          ...(detail.headSha ? { headSha: detail.headSha } : {}),
        })),
      ),

    getChangeRequestChecks: (input) =>
      readDetail(input).pipe(
        Effect.map((detail) => ({ state: detail.state, checks: detail.checks })),
      ),

    getChangeRequestWatchFingerprint: (input) =>
      api
        .get(
          {
            operation: "getChangeRequestWatchFingerprint",
            path: `${reviewPath(input.number)}?fields=${FINGERPRINT_FIELDS}`,
          },
          ReviewRequestSchema,
        )
        .pipe(Effect.map(({ data }) => watchFingerprint(data))),

    getChangeRequestActivity: (input) =>
      api
        .get(
          { operation: "getChangeRequestActivity", path: reviewPath(input.number, "/comments") },
          CommentListSchema,
        )
        .pipe(
          Effect.map(({ data }) => {
            const comments = arcanumComments(data);
            return {
              comments,
              commentCount: comments.length,
              // The comments route returns every comment at once.
              commentsTruncated: false,
              reviewThreads: [],
              commits: [],
            };
          }),
        ),

    getViewerPermissions: () => Effect.succeed(VIEWER_PERMISSIONS),

    listChangeRequests: () => unsupported("listChangeRequests"),
    getDiff: () => unsupported("getDiff"),
    runAction: () => unsupported("runAction"),
    comment: () => unsupported("comment"),
    submitReview: () => unsupported("submitReview"),
    listReviewerCandidates: () => unsupported("listReviewerCandidates"),
    setReviewerRequest: () => unsupported("setReviewerRequest"),
    replyToThread: () => unsupported("replyToThread"),
    setReaction: () => unsupported("setReaction"),
    setThreadResolution: () => unsupported("setThreadResolution"),
  };

  return provider;
});
