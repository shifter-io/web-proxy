// Display decimal GB, matching BYTE_LIMIT, and a full 24-hour countdown.
export function formatTime(seconds = 0) {
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(value => String(value).padStart(2, '0')).join(':');
}
export function formatTraffic(bytes = 0) {
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}
