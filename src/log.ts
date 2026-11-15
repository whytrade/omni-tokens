export type Log = {
  info(message: string): void;
  error(message: string, error?: unknown): void;
};

export const consoleLog: Log = {
  info: (message) => console.log(`${new Date().toISOString()} ${message}`),
  error: (message, error) =>
    console.error(`${new Date().toISOString()} ${message}${error instanceof Error ? `: ${error.message}` : error ? `: ${String(error)}` : ""}`),
};

export const silentLog: Log = { info() {}, error() {} };
