import { Router } from "express";
import * as openwebui from "../clients/openwebui.js";
import { audit } from "../audit/log.js";
import { errorMessage } from "../clients/errors.js";

export const openwebuiUsersRouter = Router();

openwebuiUsersRouter.get("/webui-users", async (_req, res, next) => {
  try {
    const users = await openwebui.listUsers();
    res.render("webui-users/list", { users });
  } catch (err) {
    next(err);
  }
});

openwebuiUsersRouter.post("/webui-users/:id/role", async (req, res, next) => {
  const role = req.body.role;
  try {
    await openwebui.updateUserRole(req.params.id, role);
    audit(req, { action: "openwebui.user.role", target: req.params.id, outcome: "success", detail: role });
    res.redirect("/webui-users");
  } catch (err) {
    audit(req, {
      action: "openwebui.user.role",
      target: req.params.id,
      outcome: "failure",
      detail: errorMessage(err),
    });
    next(err);
  }
});

openwebuiUsersRouter.post("/webui-users/:id/delete", async (req, res, next) => {
  try {
    await openwebui.deleteUser(req.params.id);
    audit(req, { action: "openwebui.user.delete", target: req.params.id, outcome: "success" });
    res.redirect("/webui-users");
  } catch (err) {
    audit(req, {
      action: "openwebui.user.delete",
      target: req.params.id,
      outcome: "failure",
      detail: errorMessage(err),
    });
    next(err);
  }
});
