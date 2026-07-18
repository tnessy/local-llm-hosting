export class UpstreamError extends Error {
  readonly service: string;
  readonly status: number | undefined;

  constructor(service: string, status: number | undefined, message: string) {
    super(message);
    this.name = "UpstreamError";
    this.service = service;
    this.status = status;
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
