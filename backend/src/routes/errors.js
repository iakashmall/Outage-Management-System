// Last stop for a request whose route threw or rejected (express-async-errors,
// imported first in index.js, forwards async route errors here). Every such
// request gets a JSON answer instead of hanging until the client gives up -
// see docs/P8_6_CROSS_SOURCE_CORRELATION_RESULTS.md.

// pg-pool's "no free connection within connectionTimeoutMillis", and pg's own
// connect timeout while the server is too busy to accept the connection.
const POOL_TIMEOUT = /timeout exceeded when trying to connect|connection terminated due to connection timeout/i;

export function isPoolTimeout(err) {
  return POOL_TIMEOUT.test(String(err?.message || ''));
}

export function errorHandler(err, req, res, next) {
  // express.json() rejections are the client's fault: answer them, no stack.
  if (err?.type === 'entity.too.large' && !res.headersSent) {
    return res.status(413).json({ error: `request body too large (limit ${Math.round(err.limit / 1024)} KB)` });
  }
  if (err?.type === 'entity.parse.failed' && !res.headersSent) {
    return res.status(400).json({ error: 'request body is not valid JSON' });
  }
  if (isPoolTimeout(err)) {
    // Expected under load, so one line without the stack.
    console.error(`[db busy] ${req.method} ${req.originalUrl}: ${err.message}`);
  } else {
    console.error(`[unhandled route error] ${req.method} ${req.originalUrl}:`, err?.stack || err);
  }
  if (res.headersSent) return next(err);
  if (isPoolTimeout(err)) return res.status(503).json({ error: 'database busy, try again' });
  res.status(500).json({ error: 'internal server error' });
}
