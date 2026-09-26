export function safeSnapshotPath(value: string) {
  return value.length > 0 && value.length <= 1024 && !/[\\\x00-\x1f\x7f:]/.test(value)
    && value.split("/").every(part => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git" && !/[. ]$/.test(part));
}
