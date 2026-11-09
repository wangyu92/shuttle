// @shuttle/adapter-server: RemoteAdapter for the own server (design §2.8, §2.9, §2.12).
export const PACKAGE_NAME = "@shuttle/adapter-server";

export {
  ServerAdapter, STATE_EPOCH_KEY, serverCapabilities, serverEnroll, serverLogin, snapshotRequiredDetails,
  type AuthOptions, type ServerAdapterOptions,
} from "./adapter";
export { DEFAULT_FEED_TIMEOUTS, FeedLink, backoffDelay, type FeedOptions, type FeedTimeouts, type HelloContext } from "./feed";
export { DEFAULT_REST_TIMEOUTS, RestClient, normalizeBaseUrls, wsUrlOf, type RestOptions, type RestTimeouts, type TokenSource } from "./rest";
export { closeAction, codeFromStatus, errorFromResponse, networkError, type CloseAction } from "./errors";
export { fetchHttpClient } from "./fetchHttp";
export { realClock, realScheduler } from "./runtime";
