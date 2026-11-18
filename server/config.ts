import { randomBytes } from "node:crypto";

const localSessionSecret = randomBytes(32).toString("hex");

export function readPort(value: string | undefined): number {
  if (value === undefined) return 3000;
  const port = Number(value);
  if (!/^\d+$/.test(value) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer from 1 to 65535.");
  }
  return port;
}

export function readAuthConfig(env: NodeJS.ProcessEnv) {
  const isProduction = env.NODE_ENV === "production";
  const clientId = env.GITHUB_CLIENT_ID?.trim() || "";
  const clientSecret = env.GITHUB_CLIENT_SECRET?.trim() || "";
  const sessionSecret = env.SESSION_SECRET?.trim() || "";
  const appUrl = env.APP_URL?.trim();

  if (isProduction) {
    const missing = [
      ["GITHUB_CLIENT_ID", clientId],
      ["GITHUB_CLIENT_SECRET", clientSecret],
      ["SESSION_SECRET", sessionSecret],
      ["APP_URL", appUrl],
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) {
      throw new Error(`Missing required production settings: ${missing.join(", ")}.`);
    }
    if (sessionSecret === clientSecret || sessionSecret === "dev-only-insecure-secret") {
      throw new Error("Set SESSION_SECRET to a dedicated random value.");
    }
  }

  const origin = appUrl || `http://localhost:${readPort(env.PORT)}`;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("APP_URL must be a valid HTTP or HTTPS origin.");
  }
  const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash || (isProduction && url.protocol === "http:" && !isLoopback)) {
    throw new Error("APP_URL must be an HTTPS origin in production, or an HTTP loopback origin for local testing.");
  }

  return { appOrigin: url.origin, clientId, clientSecret, cookieSecret: sessionSecret || localSessionSecret };
}
