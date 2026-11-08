// The one Content-Security-Policy for dev, preview, tests and deployment.
// 'wasm-unsafe-eval' is required: the NAM engine cannot instantiate its WebAssembly without it
// (measured 2026-11-08). It allows WebAssembly compilation only, not JavaScript eval.
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "script-src-attr 'none'",
  "style-src 'self'",
  "img-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

export const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}
