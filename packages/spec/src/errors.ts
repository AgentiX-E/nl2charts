/**
 * Error surface shared by every package. The brand is registered through
 * Symbol.for so that two copies of the library loaded in one process still
 * recognise each other's errors (PLT6). Never use `instanceof` across a package
 * boundary.
 */
const BRAND = Symbol.for('@agentix-e/nl2charts/error');

export const ERROR_CODES = [
  'NL2C_E_GUARD_REJECTED',
  'NL2C_E_ENGINE_UNAVAILABLE',
  'NL2C_E_ENGINE_FAILED',
  'NL2C_E_LIMIT_EXCEEDED',
  'NL2C_E_TIMEOUT',
  'NL2C_E_INVALID_IR',
  'NL2C_E_INVALID_INPUT',
  'NL2C_E_LLM_UNAVAILABLE',
  'NL2C_E_LLM_INVALID_RESPONSE',
  'NL2C_E_CONTRACT_VIOLATION',
  'NL2C_E_NOT_SUPPORTED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorDetail {
  readonly [key: string]: unknown;
}

export class Nl2ChartsError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetail;
  readonly [BRAND] = true;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown; details?: ErrorDetail }) {
    super(message, options && 'cause' in options ? { cause: options.cause } : undefined);
    this.name = 'Nl2ChartsError';
    this.code = code;
    this.details = options?.details ?? {};
  }

  toJSON(): { name: string; code: ErrorCode; message: string; details: ErrorDetail } {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

export function isNl2ChartsError(value: unknown): value is Nl2ChartsError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[BRAND] === true &&
    typeof (value as { code?: unknown }).code === 'string'
  );
}

export function toNl2ChartsError(
  code: ErrorCode,
  message: string,
  cause?: unknown,
  details?: ErrorDetail,
): Nl2ChartsError {
  const options: { cause?: unknown; details?: ErrorDetail } = {};
  if (cause !== undefined) options.cause = cause;
  if (details !== undefined) options.details = details;
  return new Nl2ChartsError(code, message, options);
}
