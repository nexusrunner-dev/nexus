// Tiny structured logger — no dependency, readable in Railway logs.
type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, scope: string, msg: string, extra?: unknown) {
  const ts = new Date().toISOString();
  const head = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  if (extra !== undefined) {
    // eslint-disable-next-line no-console
    console[level === "debug" ? "log" : level](head, extra);
  } else {
    // eslint-disable-next-line no-console
    console[level === "debug" ? "log" : level](head);
  }
}

export function createLogger(scope: string) {
  return {
    debug: (msg: string, extra?: unknown) => emit("debug", scope, msg, extra),
    info: (msg: string, extra?: unknown) => emit("info", scope, msg, extra),
    warn: (msg: string, extra?: unknown) => emit("warn", scope, msg, extra),
    error: (msg: string, extra?: unknown) => emit("error", scope, msg, extra),
  };
}

export type Logger = ReturnType<typeof createLogger>;
