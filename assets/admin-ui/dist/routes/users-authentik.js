import { Router } from "express";
import * as authentik from "../clients/authentik.js";
import { audit } from "../audit/log.js";
import { errorMessage } from "../clients/errors.js";
export const authentikUsersRouter = Router();
authentikUsersRouter.get("/users", async (_req, res, next) => {
    try {
        const users = await authentik.listUsers();
        res.render("users/list", { users });
    }
    catch (err) {
        next(err);
    }
});
authentikUsersRouter.get("/users/new", (_req, res) => {
    res.render("users/create", {});
});
authentikUsersRouter.post("/users", async (req, res, next) => {
    const { username, email, name } = req.body;
    try {
        await authentik.createUser({ username, email, name });
        audit(req, { action: "authentik.user.create", target: email, outcome: "success" });
        res.redirect("/users");
    }
    catch (err) {
        audit(req, { action: "authentik.user.create", target: email, outcome: "failure", detail: errorMessage(err) });
        next(err);
    }
});
// Deactivate only — hard delete is intentionally not exposed here, see
// clients/authentik.ts.
authentikUsersRouter.post("/users/:id/deactivate", async (req, res, next) => {
    try {
        await authentik.deactivateUser(Number(req.params.id));
        audit(req, { action: "authentik.user.deactivate", target: req.params.id, outcome: "success" });
        res.redirect("/users");
    }
    catch (err) {
        audit(req, {
            action: "authentik.user.deactivate",
            target: req.params.id,
            outcome: "failure",
            detail: errorMessage(err),
        });
        next(err);
    }
});
