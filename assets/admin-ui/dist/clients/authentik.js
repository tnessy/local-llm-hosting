import { config } from "../config.js";
import { UpstreamError } from "./errors.js";
const SERVICE = "Authentik";
async function call(path, init = {}) {
    let res;
    try {
        res = await fetch(`${config.authentikUrl}${path}`, {
            ...init,
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${config.authentikToken}`,
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
    if (res.status === 204) {
        return undefined;
    }
    return (await res.json());
}
export async function listUsers() {
    const data = await call("/api/v3/core/users/?page_size=200");
    return data.results ?? [];
}
export async function createUser(params) {
    return call("/api/v3/core/users/", {
        method: "POST",
        body: JSON.stringify({
            username: params.username,
            email: params.email,
            name: params.name,
            is_active: true,
        }),
    });
}
const groupUuidCache = new Map();
const GROUP_CACHE_TTL_MS = 60 * 60 * 1000;
async function groupUuid(name) {
    const cached = groupUuidCache.get(name);
    if (cached && Date.now() - cached.cachedAt < GROUP_CACHE_TTL_MS) {
        return cached.uuid;
    }
    const data = await call(`/api/v3/core/groups/?name=${encodeURIComponent(name)}`);
    const group = data.results?.[0];
    if (!group) {
        throw new UpstreamError(SERVICE, undefined, `Authentik group "${name}" does not exist`);
    }
    groupUuidCache.set(name, { uuid: group.pk, cachedAt: Date.now() });
    return group.pk;
}
export async function addToGroup(userId, groupName) {
    const uuid = await groupUuid(groupName);
    await call(`/api/v3/core/groups/${uuid}/add_user/`, {
        method: "POST",
        body: JSON.stringify({ pk: userId }),
    });
}
export async function deactivateUser(id) {
    await call(`/api/v3/core/users/${id}/`, {
        method: "PATCH",
        body: JSON.stringify({ is_active: false }),
    });
}
// Not wired to any route in v1 — hard delete is intentionally not exposed in
// the UI (destroys the audit-trail-adjacent user record); kept for future/CLI use.
export async function deleteUser(id) {
    await call(`/api/v3/core/users/${id}/`, { method: "DELETE" });
}
