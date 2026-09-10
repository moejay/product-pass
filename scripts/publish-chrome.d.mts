export interface ChromeServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

export function createServiceAccountAssertion(credentials: ChromeServiceAccountCredentials, now?: number): string;

export function publishChrome(options: {
  credentials: ChromeServiceAccountCredentials;
  publisherId: string | undefined;
  extensionId: string | undefined;
  archivePath: string;
  expectedVersion: string | undefined;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<void>;
