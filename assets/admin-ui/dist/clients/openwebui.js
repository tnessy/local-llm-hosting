import { config } from "../config.js";
import { UpstreamError } from "./errors.js";
const SERVICE = "Open WebUI";
async function call(path, init = {}) {
    let res;
    try {
        res = await fetch(`${config.openwebuiUrl}${path}`, {
            ...init,
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${config.openwebuiAdminKey}`,
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
export async function listUsers() {
    const data = await call("/api/v1/users/");
    return Array.isArray(data) ? data : (data.users ?? []);
}
export async function updateUserRole(id, role) {
    await call(`/api/v1/users/${id}/update`, {
        method: "POST",
        body: JSON.stringify({ role }),
    });
}
export async function deleteUser(id) {
    await call(`/api/v1/users/${id}`, { method: "DELETE" });
}
// Not wired to any route in v1 — accounts self-provision via trusted-header
// SSO on first login (see friends.ts "Add UI friend"). Kept for future use.
export async function adminCreateUser(params) {
    return call("/api/v1/auths/add", {
        method: "POST",
        body: JSON.stringify({ email: params.email, password: params.password, name: params.name, role: "user" }),
    });
}
