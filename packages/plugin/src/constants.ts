// Plugin-wide constants (design §5, §5.11).

/** Manifest id; also the folder under `<configDir>/plugins/` that the engine never syncs. */
export const PLUGIN_ID = "shuttle";
/** Display name (design §5: `PLUGIN_DISPLAY_NAME`, i18n `app.name`). */
export const PLUGIN_DISPLAY_NAME = "SHUTTLE";
/** Plugin version reported to the server and in debug info (kept equal to the engine version in v1). */
export const PLUGIN_VERSION = "0.1.0-dev.2";
/** Adapter type used in `remoteProfileId` (design UX-D1). Equals ServerAdapter.kind. */
export const SERVER_ADAPTER_TYPE = "shuttle-server";
/** Sidebar view type (design UX-D4). */
export const STATUS_VIEW_TYPE = "shuttle-status";
/** `data.json` content (design UX-D6): no settings, no secrets. */
export const DATA_JSON = Object.freeze({ schema: 1 });
/** Enrollment code lifetime requested by Add device (design §5.5.9). */
export const ENROLL_CODE_TTL_SEC = 900;
/** Device list poll while the Add device modal is open (design §5.5.9). */
export const DEVICE_POLL_MS = 3000;
/** Show `syncing` only when work lasts longer than this (design §5.2.1). */
export const SYNCING_SHOW_DELAY_MS = 400;
/** Longest wait for the server at plugin start before the cached keyring is used offline. */
export const STARTUP_INFO_TIMEOUT_MS = 5000;
