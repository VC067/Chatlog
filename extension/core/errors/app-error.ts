export const errorCodes = {
  invalidMessage: 'invalid_message',
  oversizedPayload: 'oversized_payload',
  permissionRequired: 'permission_required',
  quotaExceeded: 'quota_exceeded',
} as const;

export class AppError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}
