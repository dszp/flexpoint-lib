/**
 * @dszp/flexpoint-lib — read-only client for the FlexPoint merchant API.
 *
 * The raw transport (`FlexPointHttp`) is intentionally not exported; see `http.ts`.
 */
export { FlexPointReadClient, WALK_PAGE_SIZE } from './readClient.js';
export type { FlexPointReadClientConfig, WalkOptions } from './readClient.js';
export { DEFAULT_BASE_URL, MERCHANT_PREFIX } from './http.js';
export { FlexPointApiError, IncompleteListError } from './errors.js';
export { loginMerchant, jwtExpiryMs, LOGIN_PATH, REFRESH_SKEW_MS } from './auth.js';
export type { FlexPointAuth, IssuedToken, LoginOptions } from './auth.js';
export { parseFlexPointJson, quoteIdIntegers, isIdKey, FlexPointPrecisionError } from './json.js';
export type * from './model.js';
