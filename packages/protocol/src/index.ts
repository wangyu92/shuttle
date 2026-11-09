// @shuttle/protocol: shared types, validators and pack codec (design §2.12), plus the platform,
// state-store, keyring and engine contracts the engine is injected with (design §3).
export const PACKAGE_NAME = "@shuttle/protocol";

export type * from "./types";
export type * from "./platform";
export type * from "./keyring";
export type * from "./state";
export type * from "./engine-types";
export * from "./constants";
export * from "./errors";
export * from "./ids";
export * from "./validate";
export * from "./pack";
export * from "./canon";
export * from "./state-schema";
