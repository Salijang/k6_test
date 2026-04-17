export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export const notFound = (message: string) => new AppError(message, 404);
export const badRequest = (message: string) => new AppError(message, 400);
export const conflict = (message: string) => new AppError(message, 409);
export const unauthorized = (message: string) => new AppError(message, 401);
export const forbidden = (message: string) => new AppError(message, 403);

