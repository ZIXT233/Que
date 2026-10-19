/** The commit this build comes from (vite.config.ts); "dev" where it was not set, as in tests. */
export const BUILD_COMMIT = typeof __QUE_COMMIT__ === "string" ? __QUE_COMMIT__ : "dev";
