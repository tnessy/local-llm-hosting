import type { Request } from "express";

export type AuditOutcome = "success" | "failure";

// Structured JSON to stdout, scraped by the existing promtail -> Loki
// pipeline (assets/k8s/monitoring/promtail.yaml) — no separate log file/PVC.
// Fields match what security-review.md's M-59 fix text commits to: timestamp,
// operator identity (OIDC sub), operation type, and outcome.
export function audit(
  req: Request,
  entry: { action: string; target: string; outcome: AuditOutcome; detail?: string },
): void {
  const operator = req.session.user
    ? `${req.session.user.email} (${req.session.user.sub})`
    : "unauthenticated";
  console.log(
    JSON.stringify({
      audit: true,
      timestamp: new Date().toISOString(),
      operator,
      action: entry.action,
      target: entry.target,
      outcome: entry.outcome,
      detail: entry.detail,
    }),
  );
}
