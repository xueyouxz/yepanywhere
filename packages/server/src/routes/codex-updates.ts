import { Hono } from "hono";
import type { CodexUpdateChecker } from "../services/CodexUpdateChecker.js";

export interface CodexUpdateRoutesDeps {
  codexUpdateChecker: CodexUpdateChecker;
}

export function createCodexUpdateRoutes(deps: CodexUpdateRoutesDeps): Hono {
  const app = new Hono();
  const { codexUpdateChecker } = deps;

  app.get("/", async (c) => {
    const force = c.req.query("force") === "true";
    const status = await codexUpdateChecker.getStatus({ force });
    return c.json({ status });
  });

  app.post("/install", async (c) => {
    const result = await codexUpdateChecker.install();
    if (!result.success) {
      return c.json(result, 409);
    }
    return c.json(result);
  });

  return app;
}
