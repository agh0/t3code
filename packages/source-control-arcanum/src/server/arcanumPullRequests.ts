/**
 * Arcanum's REST shapes and their mapping. The API omits every field not named in `fields`.
 *
 * @module source-control-arcanum/server/arcanumPullRequests
 */
import * as Schema from "effect/Schema";
import type {
  PullRequestActor,
  PullRequestCheck,
  PullRequestCheckStatus,
  PullRequestChecksState,
  PullRequestComment,
  PullRequestReviewDecision,
  PullRequestState,
} from "@t3tools/contracts";
import type { ProviderChangeRequestWatchFingerprint } from "@t3tools/source-control-core/server/PullRequestProvider";

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));
const OptionalNumber = Schema.optional(Schema.NullOr(Schema.Number));
const OptionalBoolean = Schema.optional(Schema.NullOr(Schema.Boolean));
const Named = Schema.optional(Schema.NullOr(Schema.Struct({ name: OptionalString })));

const CheckSchema = Schema.Struct({
  system: Schema.String,
  type: Schema.String,
  status: OptionalString,
  satisfied: OptionalBoolean,
  required: OptionalBoolean,
  description: OptionalString,
  system_check_uri: OptionalString,
});
type ArcanumCheck = typeof CheckSchema.Type;

export const ReviewRequestSchema = Schema.Struct({
  data: Schema.Struct({
    summary: OptionalString,
    description: OptionalString,
    author: Named,
    created_at: OptionalString,
    updated_at: OptionalString,
    closed_at: OptionalString,
    merge_allowed: OptionalBoolean,
    state: OptionalString,
    vcs: Schema.optional(
      Schema.NullOr(Schema.Struct({ from_branch: OptionalString, to_branch: OptionalString })),
    ),
    active_diff_set: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          id: Schema.Number,
          patch_stats: Schema.optional(
            Schema.NullOr(Schema.Struct({ additions: OptionalNumber, deletions: OptionalNumber })),
          ),
        }),
      ),
    ),
    checks: Schema.optional(Schema.NullOr(Schema.Array(CheckSchema))),
    reviewers: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({ user: Named })))),
    labels: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({ name: OptionalString })))),
  }),
});
export type ReviewRequest = (typeof ReviewRequestSchema.Type)["data"];

export const REVIEW_REQUEST_FIELDS =
  "summary,description,author(name),created_at,updated_at,closed_at,merge_allowed,state," +
  "vcs(from_branch,to_branch),active_diff_set(id,patch_stats)," +
  "checks(system,type,status,satisfied,required,description,system_check_uri)," +
  "reviewers(user(name)),labels(name)";

export const FINGERPRINT_FIELDS =
  "state,updated_at,merge_allowed,active_diff_set(id),checks(system,type,status)";

/** `review-requests` reads `closed` for both; only `pull-requests` tells merged from discarded. */
export const PullRequestStatusSchema = Schema.Struct({
  data: Schema.Struct({ status: OptionalString }),
});

const CommentSchema = Schema.Struct({
  id: Schema.Number,
  user: Named,
  content: OptionalString,
  created_at: OptionalString,
  published_at: OptionalString,
  edited_at: OptionalString,
  draft: OptionalBoolean,
  reply_to_id: OptionalNumber,
  anchor: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        review_request: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              diff: Schema.optional(
                Schema.NullOr(
                  Schema.Struct({
                    file: Schema.optional(Schema.NullOr(Schema.Struct({ path: OptionalString }))),
                  }),
                ),
              ),
            }),
          ),
        ),
      }),
    ),
  ),
});
type ArcanumComment = typeof CommentSchema.Type;

export const CommentListSchema = Schema.Struct({ data: Schema.Array(CommentSchema) });

export function arcanumActor(name: string | null | undefined): PullRequestActor | null {
  const login = name?.trim();
  return login ? { login, name: null, avatarUrl: null, isBot: login.startsWith("robot-") } : null;
}

export function arcanumState(
  reviewState: string | null | undefined,
  pullRequestStatus: string | null | undefined,
): PullRequestState {
  if (reviewState !== "closed") return "open";
  return pullRequestStatus === "merged" ? "merged" : "closed";
}

const CHECK_STATUSES: Readonly<Record<string, PullRequestCheckStatus>> = {
  success: "success",
  failure: "failure",
  pending: "pending",
  action_required: "action-required",
  skipped: "skipped",
};

export function arcanumCheck(check: ArcanumCheck): PullRequestCheck {
  return {
    name: `${check.system}/${check.type}`,
    // `unknown` is a check not run yet: optional ones are often never run, required ones block merging.
    status:
      CHECK_STATUSES[check.status ?? ""] ??
      (check.status === "unknown" && check.required === true && check.satisfied !== true
        ? "action-required"
        : "neutral"),
    description: check.description?.trim() || null,
    url: check.system_check_uri?.trim() || null,
    required: check.required === true,
  };
}

/** Rolled up from the required checks, which are what gate a merge, else from all of them. */
export function checksState(
  checks: ReadonlyArray<PullRequestCheck>,
): PullRequestChecksState | null {
  const required = checks.filter((check) => check.required === true);
  const gate = required.length > 0 ? required : checks;
  if (gate.length === 0) return null;
  if (
    gate.some(
      (check) =>
        check.status === "failure" ||
        check.status === "cancelled" ||
        check.status === "action-required",
    )
  )
    return "failing";
  if (gate.some((check) => check.status === "pending")) return "pending";
  return "passing";
}

export function reviewDecision(checks: ReadonlyArray<ArcanumCheck>): PullRequestReviewDecision {
  return checks.some(
    (check) => check.system === "arcanum" && check.type === "approved" && check.satisfied === true,
  )
    ? "approved"
    : "review-required";
}

/** Published comments; a reply carries no anchor, so it takes the path of the one it answers. */
export function arcanumComments(
  comments: ReadonlyArray<ArcanumComment>,
): ReadonlyArray<PullRequestComment> {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const pathOf = (comment: ArcanumComment): string | null => {
    const seen = new Set<number>();
    for (let at: ArcanumComment | undefined = comment; at !== undefined;) {
      const path = at.anchor?.review_request?.diff?.file?.path?.trim();
      if (path) return path;
      if (at.reply_to_id == null || seen.has(at.id)) return null;
      seen.add(at.id);
      at = byId.get(at.reply_to_id);
    }
    return null;
  };
  return comments.flatMap((comment): PullRequestComment[] => {
    const createdAt = comment.published_at?.trim() || comment.created_at?.trim();
    if (comment.draft === true || !createdAt) return [];
    const path = pathOf(comment);
    return [
      {
        id: String(comment.id),
        kind: path === null ? "issue-comment" : "review-comment",
        author: arcanumActor(comment.user?.name),
        body: comment.content ?? "",
        createdAt,
        // `updated_at` moves whenever the thread gets a reply, so only an edit counts.
        editedAt: comment.edited_at?.trim() || null,
        url: null,
        path,
        reviewState: null,
      },
    ];
  });
}

export function watchFingerprint(review: ReviewRequest): ProviderChangeRequestWatchFingerprint {
  const checks = (review.checks ?? [])
    .map((check) => `${check.system}/${check.type}:${check.status ?? ""}`)
    .toSorted();
  return {
    status: JSON.stringify([
      review.state ?? null,
      review.active_diff_set?.id ?? null,
      review.merge_allowed ?? null,
      checks,
    ]),
    // Arcanum stamps the review whenever a comment is added.
    remarks: review.updated_at ?? "",
  };
}
