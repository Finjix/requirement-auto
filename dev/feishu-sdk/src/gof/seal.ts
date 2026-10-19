import { digest, need } from './util.ts';

const SECRET_KEYS = /authorization|cookie|password|secret|(?:access|refresh|session|id)[_-]?token/i;
const BEARER = /\bBearer\s+\S+/i;

/** Records are kept on disk and shown to people: they must never carry a credential. */
export function rejectSecrets(value: unknown): void {
  if (Array.isArray(value)) value.forEach(rejectSecrets);
  else if (value !== null && typeof value === 'object') {
    need(!Object.keys(value).some(k => SECRET_KEYS.test(k)), '记录中禁止包含认证凭据');
    Object.values(value).forEach(rejectSecrets);
  } else if (typeof value === 'string') need(!BEARER.test(value), '记录中禁止包含认证凭据');
}

/** Adds the digest of the record under `key`, so a hand-edited record is detected when it is read back. */
export function seal<T extends Record<string, unknown>>(value: T, key: string): T & Record<string, string> {
  const copy = structuredClone(value) as Record<string, unknown>;
  rejectSecrets(copy);
  copy[key] = digest(copy);
  return copy as T & Record<string, string>;
}

export function checkSeal(value: Record<string, unknown>, key: string): void {
  const { [key]: token, ...rest } = value;
  need(token === digest(rest), '接口记录摘要不匹配');
  rejectSecrets(value);
}
