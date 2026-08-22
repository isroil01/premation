/**
 * Webhook callback URL validation for automation renders.
 *
 * motion-back POSTs the render result to `callbackUrl` when a job finishes.
 * The same SSRF rules as asset URLs apply — private networks and metadata
 * endpoints must not be reachable from the server.
 */

import { isAllowedAssetUrl } from './assetUrls';

/** True when `url` is safe to receive a one-shot render webhook POST. */
export function isAllowedCallbackUrl(url: string): boolean {
  return isAllowedAssetUrl(url);
}
