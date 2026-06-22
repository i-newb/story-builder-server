const createError = require("http-errors");
const { getReasonPhrase, StatusCodes } = require("http-status-codes");

function normalizeStatusCode(statusCode) {
  if (statusCode < StatusCodes.BAD_REQUEST || statusCode >= 600) {
    return StatusCodes.INTERNAL_SERVER_ERROR;
  }

  try {
    getReasonPhrase(statusCode);
    return statusCode;
  } catch {
    return StatusCodes.INTERNAL_SERVER_ERROR;
  }
}

function notFoundHandler(req, _res, next) {
  next(createError(StatusCodes.NOT_FOUND, `Route ${req.method} ${req.originalUrl} not found`));
}

function errorHandler(err, _req, res, _next) {
  const statusCode = normalizeStatusCode(err.statusCode || err.status);
  const expose = err.expose || statusCode < StatusCodes.INTERNAL_SERVER_ERROR;
  const message = err.type === "entity.parse.failed" ? "Invalid JSON request body" : err.message;
  const payload = {
    success: false,
    code: statusCode,
    message: expose ? message : getReasonPhrase(statusCode),
  };

  if (process.env.NODE_ENV !== "production" && err.details) {
    payload.details = err.details;
  }

  if (process.env.NODE_ENV !== "production" && statusCode >= StatusCodes.INTERNAL_SERVER_ERROR) {
    console.error(err);
  }

  res.status(statusCode).json(payload);
}

module.exports = {
  notFoundHandler,
  errorHandler,
};
