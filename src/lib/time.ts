/**
 * Unix seconds. Lives here rather than in the API layer so server modules such as
 * `lib/envio/pairs` can share it without importing anything from `src/app`.
 */
export const nowSec = () => Math.floor(Date.now() / 1000);
