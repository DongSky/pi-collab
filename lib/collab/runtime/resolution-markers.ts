/** Conservative repair-only check on immutable bytes, including UTF-16 with
 * or without a BOM. Literal marker examples must be escaped/encoded explicitly.
 * Absence of markers does not decide binary, rename or deletion conflicts. */
export function assertResolutionMarkersAbsent(blobs: Buffer[]) {
  const marker = /^(?:<{7,}|={7,}|>{7,}|\|{7,})(?:[ \t].*)?\r?$/m;
  for (const bytes of blobs) {
    if (marker.test(bytes.toString("utf8").replace(/^\uFEFF/, ""))) throw new Error("snapshot_resolution_markers_present");
    if (bytes.length >= 2) {
      const pairs = bytes.subarray(0, bytes.length - bytes.length % 2);
      if (marker.test(pairs.toString("utf16le").replace(/^\uFEFF/, "")) || marker.test(Buffer.from(pairs).swap16().toString("utf16le").replace(/^\uFEFF/, "")))
        throw new Error("snapshot_resolution_markers_present");
    }
  }
}
