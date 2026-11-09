// @shuttle/engine: the sync engine (design §3). Pure TypeScript; no obsidian and no node:* imports.
// Injected: LocalFs, StateStore, RemoteAdapter, Keyring, Clock, Scheduler (design §1.1).
//
// Part 1: state DB access, index, paths, hashing and FastCDC, local events, reconciler and planner,
// merge rules. Part 2: moving data: records and ingest, blob pipeline, journal and op runner, remote
// applier with write intents and batch ordering, the action executor. createEngine() (design §3.17) is
// assembled in part 3 from these modules plus filters / config / guards / scheduling.
export const PACKAGE_NAME = "@shuttle/engine";

export * from "./types";
export * from "./errors";
export { hasFsCode } from "./platform/LocalFs";

export * from "./state/StateStore";
export * from "./state/migrations";
export * from "./state/epoch";

export * from "./path/normalize";
export * from "./path/illegal";

export * from "./content/hash";
export * from "./content/chunker";
export * from "./content/BlobPipeline";

export * from "./remote/records";
export * from "./remote/ingest";

export * from "./journal/Journal";
export * from "./journal/OpRunner";
export * from "./journal/backoff";

export * from "./apply/WriteIntents";
export * from "./apply/BatchOrderer";
export * from "./apply/RemoteApplier";

export * from "./index/FileIndex";

export * from "./events/timing";
export * from "./events/EchoSuppressor";
export * from "./events/LocalEventQueue";

export * from "./reconcile/Planner";
export * from "./reconcile/DirtySet";
export * from "./reconcile/scope";
export * from "./reconcile/fastPath";
export * from "./reconcile/LocalRenames";
export * from "./reconcile/Scanner";
export * from "./reconcile/Reconciler";
export * from "./reconcile/indexActions";
export * from "./reconcile/Executor";

export * from "./merge/dmp3";
export * from "./merge/jsonMerge";
export * from "./merge/conflictName";
export * from "./merge/MergePolicy";
export * from "./merge/Oscillation";

export * from "./util/bytes";
export * from "./util/uuid";
export * from "./util/Deferred";
export * from "./util/KeyedMutex";
export * from "./util/Lru";
export { crashPoint } from "./testing/crashPoint";

// Part 3: policy and the public API.
export * from "./filter/fileTypes";
export * from "./filter/tempFiles";
export * from "./filter/configCategories";
export * from "./filter/PathFilter";
export * from "./config/ConfigSync";
export * from "./safety/Guards";
export * from "./sched/Budget";
export * from "./log/ActivityLog";
export * from "./Engine";
