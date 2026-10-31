import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type {
  ReviewBranchCommitsInput,
  ReviewBranchCommitsResult,
  ReviewDiffFileContentsInput,
  ReviewDiffFileContentsResult,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
  VcsError,
  VcsInitInput,
  VcsListRefsInput,
  VcsListRefsResult,
  VcsListRemotesResult,
  VcsListWorkspaceFilesResult,
  VcsRepositoryIdentity,
  VcsStatusInput,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
} from "@t3tools/contracts";
import { CheckpointRef } from "@t3tools/contracts";
import * as VcsProcess from "./VcsProcess.ts";

export interface VcsWorkingTreeOps {
  readonly localStatus: (input: VcsStatusInput) => Effect.Effect<VcsStatusLocalResult, VcsError>;
  readonly currentBranch: (cwd: string) => Effect.Effect<string | null, VcsError>;
  readonly listRefs: (input: VcsListRefsInput) => Effect.Effect<VcsListRefsResult, VcsError>;
  readonly getDiffPreview: (
    input: ReviewDiffPreviewInput,
  ) => Effect.Effect<ReviewDiffPreviewResult, VcsError>;
  readonly getDiffFileContents: (
    input: ReviewDiffFileContentsInput,
  ) => Effect.Effect<ReviewDiffFileContentsResult, VcsError>;
  readonly getBranchCommits: (
    input: ReviewBranchCommitsInput,
  ) => Effect.Effect<ReviewBranchCommitsResult, VcsError>;
}

export interface VcsChangeBranchState {
  readonly branch: string | null;
  readonly defaultBranch: string;
  /** Server branch this branch publishes to; null until published. */
  readonly upstream: string | null;
  /** Server branch this branch was started from when it is not published yet. */
  readonly baseRef: string | null;
  readonly aheadCount: number;
  readonly behindCount: number;
}

export type VcsChangeRequest = NonNullable<VcsStatusRemoteResult["pr"]>;

/** Commit, push and change requests for drivers whose workflow GitManager does not own. */
export interface VcsChangeOps {
  readonly branchState: (cwd: string) => Effect.Effect<VcsChangeBranchState, VcsError>;
  readonly remoteStatus: (cwd: string) => Effect.Effect<VcsStatusRemoteResult, VcsError>;
  readonly prepareCommitContext: (
    cwd: string,
    filePaths?: ReadonlyArray<string>,
  ) => Effect.Effect<{ stagedSummary: string; stagedPatch: string } | null, VcsError>;
  readonly recentCommitSubjects: (cwd: string) => Effect.Effect<ReadonlyArray<string>, VcsError>;
  readonly listBranchNames: (cwd: string) => Effect.Effect<ReadonlyArray<string>, VcsError>;
  readonly createBranch: (cwd: string, name: string) => Effect.Effect<void, VcsError>;
  readonly commit: (
    cwd: string,
    message: string,
    filePaths?: ReadonlyArray<string>,
  ) => Effect.Effect<{ readonly commitSha: string }, VcsError>;
  readonly push: (
    cwd: string,
  ) => Effect.Effect<{ readonly upstream: string; readonly setUpstream: boolean }, VcsError>;
  readonly findChangeRequest: (
    cwd: string,
    headRef: string,
  ) => Effect.Effect<VcsChangeRequest | null, VcsError>;
  readonly readRangeContext: (
    cwd: string,
    baseRef: string,
  ) => Effect.Effect<{ commitSummary: string; diffSummary: string; diffPatch: string }, VcsError>;
  readonly createChangeRequest: (input: {
    readonly cwd: string;
    readonly title: string;
    readonly body: string;
    readonly baseRef: string | null;
  }) => Effect.Effect<{ readonly number: number; readonly url: string }, VcsError>;
}

export interface VcsCaptureCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
}

export interface VcsRestoreCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
}

export const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000;

export interface VcsDiffCheckpointsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
  readonly format?: "patch" | "numstat";
  /** Maximum bytes collected from the diff command. */
  readonly maxOutputBytes?: number;
  /** An empty list yields an empty diff. */
  readonly filePaths?: ReadonlyArray<string>;
}

export interface VcsListAuthoredPathsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
}

export interface VcsDeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

export interface VcsCheckpointOps {
  readonly captureCheckpoint: (input: VcsCaptureCheckpointInput) => Effect.Effect<void, VcsError>;
  readonly hasCheckpointRef: (
    input: Omit<VcsRestoreCheckpointInput, "fallbackToHead">,
  ) => Effect.Effect<boolean, VcsError>;
  readonly restoreCheckpoint: (
    input: VcsRestoreCheckpointInput,
  ) => Effect.Effect<boolean, VcsError>;
  readonly diffCheckpoints: (input: VcsDiffCheckpointsInput) => Effect.Effect<string, VcsError>;
  readonly listAuthoredPaths: (
    input: VcsListAuthoredPathsInput,
  ) => Effect.Effect<ReadonlySet<string> | null, VcsError>;
  readonly deleteCheckpointRefs: (
    input: VcsDeleteCheckpointRefsInput,
  ) => Effect.Effect<void, VcsError>;
}

export class VcsDriver extends Context.Service<
  VcsDriver,
  {
    readonly execute: (
      input: Omit<VcsProcess.VcsProcessInput, "command">,
    ) => Effect.Effect<VcsProcess.VcsProcessOutput, VcsError>;
    readonly checkpoints: VcsCheckpointOps;
    readonly workingTree?: VcsWorkingTreeOps;
    readonly changes?: VcsChangeOps;
    readonly detectRepository: (
      cwd: string,
    ) => Effect.Effect<VcsRepositoryIdentity | null, VcsError>;
    readonly isInsideWorkTree: (cwd: string) => Effect.Effect<boolean, VcsError>;
    readonly listWorkspaceFiles: (
      cwd: string,
    ) => Effect.Effect<VcsListWorkspaceFilesResult, VcsError>;
    readonly listRemotes: (cwd: string) => Effect.Effect<VcsListRemotesResult, VcsError>;
    readonly filterIgnoredPaths: (
      cwd: string,
      relativePaths: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<string>, VcsError>;
    readonly initRepository: (input: VcsInitInput) => Effect.Effect<void, VcsError>;
  }
>()("t3/vcs/VcsDriver") {}
