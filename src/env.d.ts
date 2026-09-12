/// <reference types="vite/client" />

interface ImportMetaEnv {
    /** Collector URL for visitor measurement events. Empty disables sending. */
    readonly VITE_STATS_ENDPOINT?: string;
    /** Optional bearer token for the collector. */
    readonly VITE_STATS_TOKEN?: string;
    /** Identifies this mirror in the measurement data. */
    readonly VITE_KIOSK_ID?: string;
    /** Overrides how strictly a returning visitor is matched (default 0.02). */
    readonly VITE_VISIT_MATCH_THRESHOLD?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
