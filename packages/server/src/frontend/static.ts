/**
 * Static file serving for production mode.
 *
 * In production, we serve the built Vite output directly from the backend.
 * This provides a single-port deployment without needing a separate web server.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Hono } from "hono";

export interface StaticServeOptions {
  /** Path to the built client dist directory */
  distPath: string;
  /** Optional base path prefix to strip from requests (e.g., "/_stable") */
  basePath?: string;
}

/**
 * Create Hono routes for serving static files.
 *
 * This serves:
 * - Static assets (JS, CSS, images) with appropriate headers
 * - index.html for all other routes (SPA fallback)
 */
export function createStaticRoutes(options: StaticServeOptions): Hono {
  const { basePath } = options;
  const distPath = path.resolve(options.distPath);
  const app = new Hono();

  // Check if dist directory exists
  if (!fs.existsSync(distPath)) {
    console.warn(
      `[Static] Warning: dist directory not found at ${distPath}. Run 'pnpm build' first.`,
    );
  }

  // Path to index.html for SPA fallback (read fresh each request to pick up rebuilds)
  const indexPath = path.join(distPath, "index.html");

  // Serve static files
  app.get("*", async (c) => {
    let reqPath = c.req.path;

    // Strip base path prefix if configured (e.g., "/_stable" -> "")
    if (basePath && reqPath.startsWith(basePath)) {
      reqPath = reqPath.slice(basePath.length) || "/";
    }

    // Try to serve the exact file
    const requestFilePath = reqPath.startsWith("/") ? reqPath.slice(1) : reqPath;
    const filePath = path.resolve(distPath, requestFilePath);

    // Security: ensure we're not escaping the dist directory
    if (!isPathInsideDirectory(filePath, distPath)) {
      return c.text("Forbidden", 403);
    }

    try {
      const stat = await fs.promises.stat(filePath);

      if (stat.isFile()) {
        const content = await fs.promises.readFile(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const contentType = getContentType(ext);

        // Cache static assets (they have hashed filenames)
        const cacheControl = isHashedAsset(reqPath)
          ? "public, max-age=31536000, immutable"
          : "public, max-age=0, must-revalidate";

        const headers: Record<string, string> = {
          "Content-Type": contentType,
          "Cache-Control": cacheControl,
        };

        // Add CSP frame-ancestors for HTML files (must be HTTP header, not meta tag)
        if (ext === ".html") {
          headers["Content-Security-Policy"] =
            "frame-ancestors 'self' tauri://localhost https://tauri.localhost";
        }

        return c.body(content, 200, headers);
      }
      // Not a file (e.g., directory), fall through to SPA fallback
    } catch (err) {
      // Only fall through to SPA for missing files, not for other errors
      const isNotFound =
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT";
      if (!isNotFound) {
        console.error(`[Static] Error serving ${filePath}:`, err);
      }
    }

    // SPA fallback: serve index.html for all other routes
    // Read fresh each time to pick up rebuilds without server restart
    try {
      const indexHtml = await fs.promises.readFile(indexPath, "utf-8");
      return c.html(indexHtml, 200, {
        // frame-ancestors must be set via HTTP header (not meta tag)
        "Content-Security-Policy":
          "frame-ancestors 'self' tauri://localhost https://tauri.localhost",
        // Don't cache index.html (hashed asset paths change on rebuild)
        "Cache-Control": "no-cache",
      });
    } catch {
      return c.text(
        "Not found. Did you run 'pnpm build' to build the client?",
        404,
      );
    }
  });

  return app;
}

export function isPathInsideDirectory(
  filePath: string,
  directory: string,
): boolean {
  const relativePath = path.relative(
    path.resolve(directory),
    path.resolve(filePath),
  );
  return (
    relativePath === "" ||
    (!!relativePath &&
      !relativePath.startsWith("..") &&
      !path.isAbsolute(relativePath))
  );
}

/**
 * Get content type for a file extension.
 */
function getContentType(ext: string): string {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".eot": "application/vnd.ms-fontobject",
    ".map": "application/json",
  };

  return types[ext] || "application/octet-stream";
}

/**
 * Check if a path is a hashed asset (can be cached forever).
 * Vite adds hashes to filenames like: index-abc123.js
 */
function isHashedAsset(reqPath: string): boolean {
  // Match patterns like: /assets/index-abc123.js or /assets/style-xyz789.css
  return /\/assets\/[^/]+-[a-f0-9]+\.[a-z]+$/i.test(reqPath);
}
