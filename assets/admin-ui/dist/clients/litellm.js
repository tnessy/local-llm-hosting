import { config } from "../config.js";
import { UpstreamError } from "./errors.js";
const SERVICE = "LiteLLM";
async function call(path, init = {}) {
    let res;
    try {
        res = await fetch(`${config.litellmUrl}${path}`, {
            ...init,
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${config.litellmMasterKey}`,
                ...init.headers,
            },
        });
    }
    catch (err) {
        throw new UpstreamError(SERVICE, undefined, `network error calling ${path}: ${err.message}`);
    }
    if (!res.ok) {
        throw new UpstreamError(SERVICE, res.status, `${path} -> ${res.status} ${await res.text()}`);
    }
    return (await res.json());
}
export async function listKeys() {
    const data = await call("/key/list");
    return data.keys ?? [];
}
export async function generateKey(params) {
    return call("/key/generate", {
        method: "POST",
        body: JSON.stringify({
            key_alias: params.alias,
            models: params.models,
            max_budget: params.maxBudget,
            budget_duration: params.budgetDuration,
            rpm_limit: params.rpmLimit,
        }),
    });
}
export async function deleteKey(key) {
    await call("/key/delete", { method: "POST", body: JSON.stringify({ keys: [key] }) });
}
export async function keyInfo(key) {
    return call(`/key/info?key=${encodeURIComponent(key)}`);
}
