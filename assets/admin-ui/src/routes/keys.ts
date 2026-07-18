import { Router } from "express";
import * as litellm from "../clients/litellm.js";
import { audit } from "../audit/log.js";
import { errorMessage } from "../clients/errors.js";

export const keysRouter = Router();

keysRouter.get("/keys", async (_req, res, next) => {
  try {
    const keys = await litellm.listKeys();
    res.render("keys/list", { keys });
  } catch (err) {
    next(err);
  }
});

keysRouter.get("/keys/mint", (_req, res) => {
  res.render("keys/mint", {});
});

keysRouter.post("/keys/mint", async (req, res, next) => {
  const { alias, models, maxBudget, budgetDuration, rpmLimit } = req.body;
  try {
    const modelList = String(models ?? "")
      .split(",")
      .map((m: string) => m.trim())
      .filter(Boolean);
    const result = await litellm.generateKey({
      alias,
      models: modelList,
      maxBudget: maxBudget ? Number(maxBudget) : undefined,
      budgetDuration: budgetDuration || undefined,
      rpmLimit: rpmLimit ? Number(rpmLimit) : undefined,
    });
    audit(req, { action: "key.mint", target: alias, outcome: "success" });
    res.render("keys/mint-result", { key: result.key, alias });
  } catch (err) {
    audit(req, { action: "key.mint", target: alias, outcome: "failure", detail: errorMessage(err) });
    next(err);
  }
});

// Revoke takes the key in the POST body rather than a URL param/query string
// so the raw key material never lands in an access log or Referer header.
keysRouter.post("/keys/revoke", async (req, res, next) => {
  const { key } = req.body;
  try {
    await litellm.deleteKey(key);
    audit(req, { action: "key.revoke", target: key, outcome: "success" });
    res.redirect("/keys");
  } catch (err) {
    audit(req, { action: "key.revoke", target: key, outcome: "failure", detail: errorMessage(err) });
    next(err);
  }
});
