/**
 * Upload one file to Box with box-node-sdk v10.
 *
 * Split out of `export-destinations.ts` for two reasons. The old code there
 * used the pre-v10 SDK — `new BoxSDK({...}).getBasicClient(token)` and
 * `client.files.uploadFile(folderId, name, buffer)` — and v10 (the generated
 * SDK this project has depended on since `^10.x`) exports no constructor at
 * all, so every Box export failed with "is not a constructor" before a byte
 * was sent. Nothing exercised the path, which is how it went unnoticed. This
 * module is the v10 call; and it has **no app imports**, so it can be driven
 * directly against a local stand-in server, which is the only way to check it
 * without a real Box account.
 *
 * The caller has already refreshed the OAuth tokens (Box rotates the refresh
 * token on every grant and the caller persists it), so this takes a plain
 * access token. `BoxDeveloperTokenAuth` is v10's holder for exactly that: a
 * fixed bearer token it never tries to refresh. If Box rejects it, the SDK's
 * retry asks the auth to refresh, which throws "Developer token has expired" —
 * and that wording is what `isAuthError` maps to "reconnect this credential".
 *
 * `baseUrls` exists for the test harness only; production leaves it unset and
 * the SDK uses Box's own hosts.
 */

import { Readable } from "node:stream";

export interface BoxUploadTarget {
  accessToken: string;
  /** Box folder id; "0" is the user's root folder. */
  folderId: string;
  filename: string;
  content: Buffer;
  /** Test-only override of the API and upload hosts. */
  baseUrls?: { baseUrl?: string; uploadUrl?: string };
}

/** Returns the id Box assigned to the uploaded file. */
export async function uploadToBox(target: BoxUploadTarget): Promise<string | null> {
  // Loaded on use, as the old `require` was: the SDK is large and only this
  // delivery path needs it.
  const { BoxClient, BoxDeveloperTokenAuth } = await import("box-node-sdk");

  let client = new BoxClient({ auth: new BoxDeveloperTokenAuth({ token: target.accessToken }) });
  if (target.baseUrls) client = client.withCustomBaseUrls(target.baseUrls);

  const files = await client.uploads.uploadFile({
    attributes: { name: target.filename, parent: { id: target.folderId } },
    file: Readable.from(target.content),
  });
  return files.entries?.[0]?.id ?? null;
}
