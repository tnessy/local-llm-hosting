import { Router } from "express";
import * as litellm from "../clients/litellm.js";
import * as authentik from "../clients/authentik.js";
import * as openwebui from "../clients/openwebui.js";
import { UpstreamError } from "../clients/errors.js";
export const dashboardRouter = Router();
dashboardRouter.get("/", async (_req, res) => {
    const counts = {
        keys: null,
        authentikUsers: null,
        webuiUsers: null,
    };
    const errors = [];
    await Promise.all([
        litellm
            .listKeys()
            .then((k) => (counts.keys = k.length))
            .catch((e) => errors.push(describeError(e))),
        authentik
            .listUsers()
            .then((u) => (counts.authentikUsers = u.length))
            .catch((e) => errors.push(describeError(e))),
        openwebui
            .listUsers()
            .then((u) => (counts.webuiUsers = u.length))
            .catch((e) => errors.push(describeError(e))),
    ]);
    res.render("dashboard", { counts, errors });
});
function describeError(err) {
    return err instanceof UpstreamError ? `${err.service} unreachable: ${err.message}` : String(err);
}
