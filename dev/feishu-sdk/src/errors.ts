/** Failure categories the callers (the bridge and the gof command line) branch on; the message is for people. */
export type ErrorKind =
  | 'config'            // app credentials or data directory missing / invalid
  | 'auth_required'     // not logged in, or the login expired
  | 'login_denied'      // the user refused the authorization
  | 'login_expired'     // the pending device authorization ran out
  | 'identity_mismatch' // the authorizing account is not the user this process serves
  | 'scope_missing'     // the token lacks a permission the call needs
  | 'invalid_request'   // refused locally before anything was sent
  | 'occupied'          // the server refused to overwrite non-empty cells
  | 'unknown_result'    // a write may or may not have been applied: read back, never resend
  | 'network'           // nothing reached the server (or no answer came back from a read)
  | 'api';              // the server answered with an error

export class BridgeError extends Error {
  kind: ErrorKind;
  code: number | undefined;
  constructor(kind: ErrorKind, message: string, code?: number) {
    super(message);
    this.name = 'BridgeError';
    this.kind = kind;
    this.code = code;
  }
}

export interface ErrorPayload { kind: ErrorKind; code?: number; message: string }

/** Removes credentials from text that is about to leave the process (tool results, stdout, logs). */
export function redact(text: string, secrets: Iterable<string> = []): string {
  let out = text.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/\b([uc]-[A-Za-z0-9_-]{20,})\b/g, '[REDACTED]');
  for (const secret of secrets) if (secret && secret.length >= 6) out = out.split(secret).join('[REDACTED]');
  return out;
}

export function toPayload(error: unknown, secrets: Iterable<string> = []): ErrorPayload {
  if (error instanceof BridgeError) {
    const payload: ErrorPayload = { kind: error.kind, message: redact(error.message, secrets) };
    if (error.code !== undefined) payload.code = error.code;
    return payload;
  }
  return { kind: 'api', message: redact(error instanceof Error ? error.message : '未知错误', secrets) };
}
