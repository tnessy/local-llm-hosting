export class UpstreamError extends Error {
    service;
    status;
    constructor(service, status, message) {
        super(message);
        this.name = "UpstreamError";
        this.service = service;
        this.status = status;
    }
}
export function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
