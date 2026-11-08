// ─── Download ───────────────────────────────────────────────────────
// Export hands the take to the player as one ordinary file: an object URL,
// clicked as a download link, then revoked. Nothing goes over the network.

export interface DownloadFile { name: string; blob: Blob }

// Revoking at once can cancel a download the browser has not started reading
// (Firefox); a short wait costs a few MB of memory for a few seconds.
const REVOKE_AFTER_MS = 10_000

export function downloadFile(file: DownloadFile): void {
  const url = URL.createObjectURL(file.blob)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  a.hidden = true
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS)
}
