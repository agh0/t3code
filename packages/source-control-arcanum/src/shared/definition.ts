import { type PullRequestAction, SourceControlProviderKind } from "@t3tools/contracts";
import {
  defineSourceControl,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
  type ParsedChangeRequestUrl,
  projectChangeRequestHost,
} from "@t3tools/source-control-core/shared/definition";

export const ARCANUM_HOST = "a.yandex-team.ru";
/** Arcanum reviews one monorepository, so every review is keyed under it. */
const ARCANUM_REPOSITORY = "arcadia";

const CHECKOUT_COMMAND = /^arc\s+pr\s+checkout\s+(.+)$/i;
const CHANGE_REQUEST_PATH = /^\/review\/(\d+)(?:\/|$)/u;

const KIND = SourceControlProviderKind.make("arcanum");

export function parseChangeRequestUrl(url: URL): ParsedChangeRequestUrl | null {
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname.toLowerCase() !== ARCANUM_HOST) return null;
  const number = Number(CHANGE_REQUEST_PATH.exec(url.pathname)?.[1]);
  return Number.isSafeInteger(number) && number > 0
    ? {
        host: ARCANUM_HOST,
        repository: ARCANUM_REPOSITORY,
        number,
        repositoryUrl: `https://${ARCANUM_HOST}/${ARCANUM_REPOSITORY}`,
      }
    : null;
}

export const definition = defineSourceControl({
  kind: KIND,
  label: "Arcanum",
  pickerLabel: "Arcanum",
  icon: null,
  searchKeywords: ["arc", "arcadia", "yandex"],
  changeRequest: {
    shortLabel: "PR",
    shortLabelWithArticle: "a PR",
    singular: "pull request",
    plural: "pull requests",
  },
  repositoryPathHint: ARCANUM_REPOSITORY,
  publicHost: ARCANUM_HOST,
  publishDescription: ARCANUM_HOST,
  publishHost: () => ARCANUM_HOST,
  newRepositoryOwner: () => null,
  defaultCloneTransport: "https",
  changeRequestUrl: ({ number }) => `https://${ARCANUM_HOST}/review/${number}`,
  parseChangeRequestUrl,
  changeRequestUrlFromReferenceAutolink: () => null,
  changeRequestActions: new Set<PullRequestAction>(),
  checkoutCommand: ({ number }) => `arc pr checkout ${number}`,
  changeRequestCloseCommand: /\barc\s+pr\s+discard\b/u,
  authorProfileUrl: () => null,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: (input) => CHECKOUT_COMMAND.exec(input)?.[1]?.trim() ?? null,
  isChangeRequestReference: (url) =>
    URL.canParse(url) && parseChangeRequestUrl(new URL(url)) !== null,
  checkoutChangeRequestHost: (identity) => projectChangeRequestHost(identity, KIND),
  // Arc working copies have no git remote, so no remote is ever Arcanum's.
  recognizeRemote: () => null,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(projectChangeRequestHost(identity, KIND), identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(projectChangeRequestHost(identity, KIND), identity, link),
});
