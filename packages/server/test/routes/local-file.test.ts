import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalFileRoutes } from "../../src/routes/local-file.js";

describe("Local file routes", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "yep-local-file-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("serves Markdown files from allowed directories as readable text", async () => {
    const allowedDir = path.join(tempDir, "allowed");
    await mkdir(allowedDir, { recursive: true });

    const filePath = path.join(allowedDir, "notes.md");
    await writeFile(filePath, "# Notes\n\nText");

    const routes = createLocalFileRoutes({
      allowedPaths: [allowedDir],
    });

    const response = await routes.request(
      `/?path=${encodeURIComponent(filePath)}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("# Notes\n\nText");
  });

  it("serves HTML and PDF files inline from allowed directories", async () => {
    const allowedDir = path.join(tempDir, "allowed");
    await mkdir(allowedDir, { recursive: true });

    const htmlPath = path.join(allowedDir, "README.print.html");
    const imagePath = path.join(allowedDir, "views", "shot.png");
    await mkdir(path.dirname(imagePath), { recursive: true });
    const pdfPath = path.join(allowedDir, "README.pdf");
    await writeFile(
      htmlPath,
      `<!doctype html><base href="file://${allowedDir}/"><title>Readme</title><img src="views/shot.png"><a href="README.pdf">PDF</a><a href="#local">Local</a>`,
    );
    await writeFile(imagePath, "png");
    await writeFile(pdfPath, "%PDF-1.4\n");

    const routes = createLocalFileRoutes({ allowedPaths: [allowedDir] });

    const htmlResponse = await routes.request(
      `/?path=${encodeURIComponent(htmlPath)}`,
    );
    expect(htmlResponse.status).toBe(200);
    expect(htmlResponse.headers.get("content-type")?.toLowerCase()).toBe(
      "text/html; charset=utf-8",
    );
    const html = await htmlResponse.text();
    expect(html).toContain("<title>Readme</title>");
    expect(html).not.toContain("file://");
    expect(html).toContain(
      `src="/api/local-image?path=${encodeURIComponent(imagePath)}"`,
    );
    expect(html).toContain(
      `href="/api/local-file?path=${encodeURIComponent(pdfPath)}"`,
    );
    expect(html).toContain('href="#local"');

    const pdfResponse = await routes.request(
      `/?path=${encodeURIComponent(pdfPath)}`,
    );
    expect(pdfResponse.status).toBe(200);
    expect(pdfResponse.headers.get("content-type")).toBe("application/pdf");
    expect(await pdfResponse.text()).toBe("%PDF-1.4\n");
  });

  it("renders Markdown files with relative images when requested", async () => {
    const allowedDir = path.join(tempDir, "allowed");
    const docsDir = path.join(allowedDir, "docs");
    await mkdir(docsDir, { recursive: true });

    const imagePath = path.join(docsDir, "diagram.svg");
    const filePath = path.join(docsDir, "notes.md");
    await writeFile(imagePath, "<svg></svg>");
    await writeFile(
      filePath,
      "# Notes\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n![diagram](diagram.svg)",
    );

    const routes = createLocalFileRoutes({
      allowedPaths: [allowedDir],
    });

    const response = await routes.request(
      `/?path=${encodeURIComponent(filePath)}&render=1`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")?.toLowerCase()).toBe(
      "text/html; charset=utf-8",
    );
    const html = await response.text();
    expect(html).toContain("<h1>Notes</h1>");
    expect(html).toContain("<table>");
    const resolvedImagePath = await realpath(imagePath);
    expect(html).toContain(
      `src="/api/local-image?path=${encodeURIComponent(resolvedImagePath)}"`,
    );
    expect(html).toContain("Raw");
    expect(html).toContain("document-actions__dock");
    expect(html).toContain("Keep raw link at document top");
    expect(html).not.toContain("Print");
  });

  it("treats an inline markdown line suffix as a location hint", async () => {
    const allowedDir = path.join(tempDir, "allowed");
    await mkdir(allowedDir, { recursive: true });

    const filePath = path.join(allowedDir, "notes.md");
    await writeFile(filePath, "# Notes\n\nText");

    const routes = createLocalFileRoutes({
      allowedPaths: [allowedDir],
    });

    const response = await routes.request(
      `/?path=${encodeURIComponent(`${filePath}:2`)}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")?.toLowerCase()).toBe(
      "text/html; charset=utf-8",
    );
    const html = await response.text();
    expect(html).toContain("<h1>Notes</h1>");
    expect(html).toContain("Raw");
  });

  it("rejects non-text media extensions", async () => {
    const allowedDir = path.join(tempDir, "allowed");
    await mkdir(allowedDir, { recursive: true });

    const filePath = path.join(allowedDir, "screenshot.png");
    await writeFile(filePath, "png-bytes");

    const routes = createLocalFileRoutes({
      allowedPaths: [allowedDir],
    });

    const response = await routes.request(
      `/?path=${encodeURIComponent(filePath)}`,
    );

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({
      error: "Not a supported local file",
    });
  });
});
