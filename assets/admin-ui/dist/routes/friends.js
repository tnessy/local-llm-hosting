import { Router } from "express";
import * as authentik from "../clients/authentik.js";
import * as litellm from "../clients/litellm.js";
import { audit } from "../audit/log.js";
import { errorMessage } from "../clients/errors.js";
export const friendsRouter = Router();
friendsRouter.get("/friends/api", (_req, res) => {
    res.render("friends/add-api", {});
});
friendsRouter.post("/friends/api", async (req, res) => {
    const { username, email, name, models, maxBudget, budgetDuration, rpmLimit } = req.body;
    let createdUserId;
    try {
        const user = await authentik.createUser({ username, email, name });
        createdUserId = user.pk;
        await authentik.addToGroup(user.pk, "grp-api");
        const modelList = String(models ?? "")
            .split(",")
            .map((m) => m.trim())
            .filter(Boolean);
        const { key } = await litellm.generateKey({
            alias: username,
            models: modelList,
            maxBudget: maxBudget ? Number(maxBudget) : undefined,
            budgetDuration: budgetDuration || undefined,
            rpmLimit: rpmLimit ? Number(rpmLimit) : undefined,
        });
        audit(req, { action: "friend.add_api", target: email, outcome: "success" });
        res.render("friends/add-api-result", { key, username, email });
    }
    catch (err) {
        const detail = createdUserId
            ? `Authentik user #${createdUserId} (${username}) was created and added to grp-api, but minting ` +
                `the LiteLLM key failed: ${errorMessage(err)}. Retry from /keys/mint with alias "${username}", ` +
                `or deactivate the Authentik account to roll back.`
            : errorMessage(err);
        audit(req, { action: "friend.add_api", target: email, outcome: "failure", detail });
        res.status(500).render("error", { title: "Add API friend failed", message: detail });
    }
});
friendsRouter.get("/friends/ui", (_req, res) => {
    res.render("friends/add-ui", {});
});
friendsRouter.post("/friends/ui", async (req, res, next) => {
    const { username, email, name } = req.body;
    try {
        const user = await authentik.createUser({ username, email, name });
        await authentik.addToGroup(user.pk, "grp-ui");
        audit(req, { action: "friend.add_ui", target: email, outcome: "success" });
        res.redirect("/users");
    }
    catch (err) {
        audit(req, { action: "friend.add_ui", target: email, outcome: "failure", detail: errorMessage(err) });
        next(err);
    }
});
