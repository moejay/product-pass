export const ext: typeof chrome = ((globalThis as typeof globalThis & { browser?: typeof chrome }).browser ?? globalThis.chrome);

export function runtimeErrorMessage(): string | undefined {
  return ext.runtime.lastError?.message;
}
