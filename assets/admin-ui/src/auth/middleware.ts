import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.user) {
    return res.redirect(`/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
}

// Re-checked on every request (not just at login) so a grp-admin removal in
// Authentik takes effect within one request instead of surviving the full
// session lifetime — the design doc's "two independent gates" applied at the
// app layer too.
export function requireAdminGroup(req: Request, res: Response, next: NextFunction) {
  const user = req.session.user;
  if (!user || !user.groups.includes(config.requiredGroup)) {
    return res.status(403).render("error", {
      title: "Access denied",
      message: `Your account is not a member of ${config.requiredGroup}.`,
    });
  }
  next();
}
