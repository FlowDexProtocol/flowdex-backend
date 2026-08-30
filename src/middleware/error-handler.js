// ══════════════════════════════════════════════════
// src/middleware/error-handler.js
// Catches all errors and returns consistent format
// ══════════════════════════════════════════════════

function errorHandler(err, req, res, next) {
  console.error('[ERROR]', req.method, req.path, err.message);

  // Don't leak stack traces in production
  const isDev = process.env.NODE_ENV === 'development';

  res.status(err.statusCode || 500).json({
    success: false,
    error: err.message || 'Internal server error',
    code: err.code || 'INTERNAL_ERROR',
    ...(isDev && { stack: err.stack }),
  });
}

// Custom error class
class AppError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

module.exports = { errorHandler, AppError };
