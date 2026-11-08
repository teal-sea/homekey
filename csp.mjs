// The one Content-Security-Policy for dev, preview, tests and deployment.
// 'wasm-unsafe-eval' is required: the NAM engine cannot instantiate its WebAssembly without it
// (measured 2026-11-08). It allows WebAssembly compilation only, not JavaScript eval.
// Only directives something needs: images (the favicon) fall back to default-src 'self',
// nothing plays media from a URL or starts a Worker, and the export's blob: URL is only a
// download link's target, which no fetch directive governs.
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "script-src-attr 'none'",
  "style-src 'self'",
  "connect-src 'self'",
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
