import type { Request } from "express";
import { doubleCsrf } from "csrf-csrf";
import { config } from "../config.js";

export const { doubleCsrfProtection, generateToken: generateCsrfToken } = doubleCsrf({
  getSecret: () => config.csrfSecret,
  getSessionIdentifier: (req) => req.session.id,
  cookieName: "admin_ui_csrf",
  cookieOptions: {
    sameSite: "lax",
    secure: config.nodeEnv === "production",
    path: "/",
  },
  // Server-rendered forms post the token as a hidden field, not a header.
  getTokenFromRequest: (req: Request) => req.body?._csrf,
});
