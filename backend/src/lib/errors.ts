/** Uygulama hatalari ve HTTP hata yanitlari. */

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Kimlik dogrulanmadi') =>
  new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'Bu islem icin yetkiniz yok') =>
  new AppError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Kayit bulunamadi') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'CONFLICT', message, details);
export const unprocessable = (message: string, details?: unknown) =>
  new AppError(422, 'UNPROCESSABLE_ENTITY', message, details);
export const tooManyRequests = (message = 'Cok fazla istek') =>
  new AppError(429, 'RATE_LIMITED', message);
