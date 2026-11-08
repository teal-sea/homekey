// ─── Downloads ──────────────────────────────────────────────────────
// Export hands the take to the player as ordinary files: one object URL per
// file, clicked as a download link, then revoked. Nothing goes over the network.

export interface DownloadFile { name: string; blob: Blob }

// Revoking at once can cancel a download the browser has not started reading
// (Firefox); a short wait costs a few MB of memory for a few seconds.
const REVOKE_AFTER_MS = 10_000

export function downloadFiles(files: readonly DownloadFile[]): void {
  for (const file of files) {
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
}
