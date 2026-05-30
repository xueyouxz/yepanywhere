import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { extname } from "node:path";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import type { ProjectScanner } from "../projects/scanner.js";

interface LocalFileDeps {
  allowedPaths: string[];
  scanner?: Pick<ProjectScanner, "listProjects">;
}

const TEXT_FILE_CONTENT_TYPES: Record<string, string> = {
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".markdown": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".toml": "text/x-toml; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
};

/**
 * Create routes for serving local text files from allowed paths.
 *
 * Security: Only serves files that:
 * 1. Have a recognized text extension
 * 2. Resolve (after symlink resolution) to a path under an allowed prefix
 * 3. Are regular files (not directories, devices, etc.)
 */
export function createLocalFileRoutes(deps: LocalFileDeps) {
  const routes = new Hono();

  let resolvedAllowedPaths: string[] | null = null;
  async function getAllowedPaths(): Promise<string[]> {
    if (!resolvedAllowedPaths) {
      resolvedAllowedPaths = await Promise.all(
        deps.allowedPaths.map(async (p) => {
          try {
            return await realpath(p);
          } catch {
            return p;
          }
        }),
      );
    }
    if (!deps.scanner) {
      return resolvedAllowedPaths;
    }

    const projects = await deps.scanner.listProjects();
    const projectPaths = await Promise.all(
      projects.map(async (project) => {
        try {
          return await realpath(project.path);
        } catch {
          return null;
        }
      }),
    );

    return Array.from(
      new Set([
        ...resolvedAllowedPaths,
        ...projectPaths.filter((path): path is string => Boolean(path)),
      ]),
    );
  }

  routes.get("/", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) {
      return c.json({ error: "Missing path parameter" }, 400);
    }

    if (!filePath.startsWith("/")) {
      return c.json({ error: "Path must be absolute" }, 400);
    }

    const contentType = TEXT_FILE_CONTENT_TYPES[extname(filePath).toLowerCase()];
    if (!contentType) {
      return c.json({ error: "Not a supported text file" }, 415);
    }

    let resolvedPath: string;
    try {
      resolvedPath = await realpath(filePath);
    } catch {
      return c.json({ error: "File not found" }, 404);
    }

    const allowed = await getAllowedPaths();
    const isAllowed = allowed.some((prefix) =>
      resolvedPath.startsWith(`${prefix}/`),
    );
    if (!isAllowed) {
      return c.json({ error: "Path not in allowed directories" }, 403);
    }

    try {
      const stats = await stat(resolvedPath);
      if (!stats.isFile()) {
        return c.json({ error: "Not a file" }, 404);
      }

      c.header("Content-Type", contentType);
      c.header("Content-Length", stats.size.toString());
      c.header("Content-Disposition", "inline");
      c.header("Cache-Control", "private, max-age=60");
      c.header("X-Content-Type-Options", "nosniff");

      return stream(c, async (s) => {
        const readable = createReadStream(resolvedPath);
        for await (const chunk of readable) {
          await s.write(chunk);
        }
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return c.json({ error: "File not found" }, 404);
      }
      console.error("[LocalFile] Error serving file:", err);
      return c.json({ error: "Internal error" }, 500);
    }
  });

  return routes;
}
