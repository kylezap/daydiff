/**
 * Timestamped logger for CLI output.
 * All messages are prefixed with [HH:mm:ss].
 */

function timestamp() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function format(msg) {
  const ts = timestamp();
  return msg.split('\n').map(line => `[${ts}] ${line}`).join('\n');
}

export const log = (...args) => {
  const msg = args.length === 1 ? String(args[0]) : args.map(String).join(' ');
  console.log(format(msg));
};

export const warn = (...args) => {
  const msg = args.length === 1 ? String(args[0]) : args.map(String).join(' ');
  console.warn(format(msg));
};

export const error = (...args) => {
  const msg = args.length === 1 ? String(args[0]) : args.map(String).join(' ');
  console.error(format(msg));
};
