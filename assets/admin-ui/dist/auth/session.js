import session from "express-session";
import { config } from "../config.js";
// MemoryStore is safe only because this Deployment is pinned to replicas: 1
// (assets/k8s/llm-platform/admin-ui.yaml) — with >1 replica, sessions would
// live on whichever pod handled login and half of requests would look logged
// out. Revisit if this service is ever scaled up.
export const sessionMiddleware = session({
    name: "admin_ui_sid",
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: config.nodeEnv === "production",
        sameSite: "lax",
        maxAge: config.sessionDurationHours * 60 * 60 * 1000,
        path: "/",
    },
});
