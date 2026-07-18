import { Router } from "express";
import { buildAuthorizationUrl, handleCallback } from "../auth/oidc.js";
import { audit } from "../audit/log.js";
import { config } from "../config.js";
import { errorMessage } from "../clients/errors.js";

export const authRouter = Router();

authRouter.get("/login", async (req, res, next) => {
  try {
    const returnTo = typeof req.query.returnTo === "string" ? req.query.returnTo : "/";
    const url = await buildAuthorizationUrl(req, returnTo);
    res.redirect(url);
  } catch (err) {
    next(err);
  }
});

authRouter.get("/callback", async (req, res, next) => {
  try {
    const returnTo = req.session.oidc?.returnTo ?? "/";
    const user = await handleCallback(req);
    req.session.oidc = undefined;

    if (!user.groups.includes(config.requiredGroup)) {
      audit(req, {
        action: "login",
        target: user.email,
        outcome: "failure",
        detail: `missing ${config.requiredGroup}`,
      });
      return res.status(403).render("error", {
        title: "Access denied",
        message: `${user.email} is not a member of ${config.requiredGroup}.`,
      });
    }

    req.session.user = user;
    audit(req, { action: "login", target: user.email, outcome: "success" });
    res.redirect(returnTo);
  } catch (err) {
    audit(req, { action: "login", target: "unknown", outcome: "failure", detail: errorMessage(err) });
    next(err);
  }
});

authRouter.post("/logout", (req, res) => {
  const email = req.session.user?.email ?? "unknown";
  audit(req, { action: "logout", target: email, outcome: "success" });
  req.session.destroy(() => {
    res.redirect("/login");
  });
});
