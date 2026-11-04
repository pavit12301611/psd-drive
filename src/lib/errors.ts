/** Typed HTTP errors with stable machine-readable codes. */
export class HttpError extends Error {
  status: number
  code: string
  details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'BAD_REQUEST', message, details)
export const unauthorized = (message = 'Sign in to continue.') =>
  new HttpError(401, 'UNAUTHORIZED', message)
export const forbidden = (message = 'You do not have access to this resource.') =>
  new HttpError(403, 'FORBIDDEN', message)
export const notFound = (message = 'Not found.') => new HttpError(404, 'NOT_FOUND', message)
export const conflict = (message: string) => new HttpError(409, 'CONFLICT', message)
export const tooLarge = (message = 'That file is too large.') =>
  new HttpError(413, 'PAYLOAD_TOO_LARGE', message)
export const rateLimited = (message = 'Too many requests. Slow down a little.') =>
  new HttpError(429, 'RATE_LIMITED', message)
export const badGateway = (message: string, details?: unknown) =>
  new HttpError(502, 'PROVIDER_ERROR', message, details)
