import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileContentResponse } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { MockClaudeSDK } from "../../src/sdk/mock.js";
import { encodeProjectId } from "../../src/supervisor/types.js";

describe("Files API", () => {
  let mockSdk: MockClaudeSDK;
  let testDir: string;
  let projectId: string;
  let projectPath: string;

  beforeEach(async () => {
    mockSdk = new MockClaudeSDK();

    // Create temp directory structure with a valid project
    testDir = join(tmpdir(), `claude-test-${randomUUID()}`);
    projectPath = join(testDir, "myproject");
    projectId = encodeProjectId(projectPath);
    const encodedPath = projectPath.replaceAll("/", "-");

    // Create project directory
    await mkdir(projectPath, { recursive: true });

    // Create sessions directory for project discovery
    const sessionsDir = join(testDir, "sessions", "localhost", encodedPath);
    await mkdir(sessionsDir, { recursive: true });

    // Session file must include cwd field for project path discovery
    await writeFile(
      join(sessionsDir, "sess-existing.jsonl"),
      `{"type":"user","cwd":"${projectPath}","message":{"content":"Hello"}}\n`,
    );

    // Create test files in project
    await mkdir(join(projectPath, "src"), { recursive: true });
    await writeFile(
      join(projectPath, "README.md"),
      "# Test Project\n\nThis is a test.",
    );
    await mkdir(join(projectPath, "docs", "assets"), { recursive: true });
    await writeFile(join(projectPath, "docs", "peer.md"), "# Peer");
    await writeFile(
      join(projectPath, "docs", "guide.md"),
      "# Guide\n\n[Peer](peer.md)\n\n![Diagram](assets/diagram.svg)",
    );
    await writeFile(
      join(projectPath, "docs", "assets", "diagram.svg"),
      "<svg></svg>",
    );
    await writeFile(
      join(projectPath, "src", "index.ts"),
      'console.log("Hello, world!");',
    );
    await writeFile(join(projectPath, "data.json"), '{"key": "value"}');

    // Create a binary-like file (small PNG header)
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    await writeFile(join(projectPath, "image.png"), pngHeader);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("GET /api/projects/:projectId/files", () => {
    it("returns file metadata and content for text file", async () => {
      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=README.md`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.metadata.path).toBe("README.md");
      expect(json.metadata.mimeType).toBe("text/markdown");
      expect(json.metadata.isText).toBe(true);
      expect(json.metadata.size).toBeGreaterThan(0);
      expect(json.content).toBe("# Test Project\n\nThis is a test.");
      expect(json.rawUrl).toContain("/api/projects/");
      expect(json.rawUrl).toContain("/files/raw?path=README.md");
    });

    it("renders Markdown previews with relative project media resolved", async () => {
      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=docs/guide.md&highlight=true`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      const peerPath = await realpath(join(projectPath, "docs", "peer.md"));
      const diagramPath = await realpath(
        join(projectPath, "docs", "assets", "diagram.svg"),
      );
      expect(json.renderedMarkdownHtml).toContain("<h1>Guide</h1>");
      expect(json.renderedMarkdownHtml).toContain(
        `href="/api/local-file?path=${encodeURIComponent(peerPath)}&amp;render=1"`,
      );
      expect(json.renderedMarkdownHtml).toContain(
        `data-media-path="${diagramPath}"`,
      );
      expect(json.embeddedMedia?.[diagramPath]).toEqual({
        data: Buffer.from("<svg></svg>").toString("base64"),
        mimeType: "image/svg+xml",
      });
      expect(json.embeddedMedia?.["docs/assets/diagram.svg"]).toEqual(
        json.embeddedMedia?.[diagramPath],
      );
    });

    it("wraps requested Markdown preview line ranges", async () => {
      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=docs/guide.md&highlight=true&line=1&lineEnd=3`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.renderedMarkdownHtml).toContain(
        'class="markdown-preview-line-boundary markdown-preview-line-boundary-start" data-line="1"',
      );
      expect(json.renderedMarkdownHtml).toContain(
        'class="markdown-preview-span markdown-preview-span-start" data-line-start="1" data-line-end="3"',
      );
      expect(json.renderedMarkdownHtml).toContain(
        'class="markdown-preview-line-boundary markdown-preview-line-boundary-end" data-line="3"',
      );
    });

    it("snaps split Markdown preview ranges to block boundaries", async () => {
      await writeFile(
        join(projectPath, "docs", "list.md"),
        "# Snap\n\n- first\n- selected\n- last\n\nTail",
      );
      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=docs/list.md&highlight=true&line=4&lineEnd=4`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.renderedMarkdownHtml).toContain(
        'class="markdown-preview-span markdown-preview-span-start" data-line-start="3" data-line-end="5"',
      );
      expect(json.renderedMarkdownHtml).toContain("<li>first</li>");
      expect(json.renderedMarkdownHtml).toContain("<li>selected</li>");
      expect(json.renderedMarkdownHtml).toContain("<li>last</li>");
    });

    it("keeps Markdown reference definitions available in range previews", async () => {
      await writeFile(
        join(projectPath, "docs", "references.md"),
        "See [Peer][peer]\n\nContext\n\n[peer]: peer.md",
      );
      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=docs/references.md&highlight=true&view=range&line=1&lineEnd=1`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      const peerPath = await realpath(join(projectPath, "docs", "peer.md"));
      expect(json.content).toBe("See [Peer][peer]");
      expect(json.renderedMarkdownHtml).toContain(
        'class="markdown-preview-span markdown-preview-span-start" data-line-start="1" data-line-end="1"',
      );
      expect(json.renderedMarkdownHtml).toContain(
        `href="/api/local-file?path=${encodeURIComponent(peerPath)}&amp;render=1"`,
      );
    });

    it("uses bounded Markdown context for large range previews", async () => {
      await writeFile(
        join(projectPath, "docs", "large-references.md"),
        [
          "See [Peer][peer]",
          "",
          "[peer]: peer.md",
          "",
          "tail\n".repeat(240_000),
        ].join("\n"),
      );
      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=docs/large-references.md&highlight=true&view=range&line=1&lineEnd=1`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      const peerPath = await realpath(join(projectPath, "docs", "peer.md"));
      expect(json.content).toBe("See [Peer][peer]");
      expect(json.renderedMarkdownHtml).toContain(
        `href="/api/local-file?path=${encodeURIComponent(peerPath)}&amp;render=1"`,
      );
    });

    it("returns file metadata and content for TypeScript file", async () => {
      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=src/index.ts`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.metadata.path).toBe("src/index.ts");
      expect(json.metadata.mimeType).toBe("text/typescript");
      expect(json.metadata.isText).toBe(true);
      expect(json.content).toBe('console.log("Hello, world!");');
    });

    it("returns file metadata without content for binary file", async () => {
      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=image.png`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.metadata.path).toBe("image.png");
      expect(json.metadata.mimeType).toBe("image/png");
      expect(json.metadata.isText).toBe(false);
      expect(json.content).toBeUndefined();
      expect(json.rawUrl).toContain("image.png");
    });

    it("returns 400 for missing path parameter", async () => {
      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(`/api/projects/${projectId}/files`);

      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("Missing path parameter");
    });

    it("returns 400 for invalid project ID format", async () => {
      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        "/api/projects/invalid!project/files?path=README.md",
      );

      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("Invalid project ID format");
    });

    it("returns 404 for non-existent project", async () => {
      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const fakeProjectId = encodeProjectId("/nonexistent/project");
      const res = await app.request(
        `/api/projects/${fakeProjectId}/files?path=README.md`,
      );

      expect(res.status).toBe(404);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("Project not found");
    });

    it("returns 404 for non-existent file", async () => {
      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=nonexistent.txt`,
      );

      expect(res.status).toBe(404);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("File not found");
    });

    it("returns 400 for path traversal attempt with ..", async () => {
      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=../../../etc/passwd`,
      );

      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("Invalid file path");
    });

    it("returns file metadata and content for absolute live file path", async () => {
      const outsideDir = join(testDir, "outside");
      const outsideFile = join(outsideDir, "notes.txt");
      await mkdir(outsideDir, { recursive: true });
      await writeFile(outsideFile, "outside notes");

      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=${encodeURIComponent(outsideFile)}`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.metadata.path).toBe(outsideFile);
      expect(json.content).toBe("outside notes");
      expect(json.rawUrl).toContain(encodeURIComponent(outsideFile));
    });

    it("returns 400 for symlink escaping project root", async () => {
      const outsideDir = join(testDir, "outside");
      const outsideFile = join(outsideDir, "secret.txt");
      const linkPath = join(projectPath, "outside-link.txt");
      await mkdir(outsideDir, { recursive: true });
      await writeFile(outsideFile, "outside secret");
      await symlink(outsideFile, linkPath);

      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=outside-link.txt`,
      );

      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("Invalid file path");
    });

    it("returns 400 for directory path", async () => {
      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=src`,
      );

      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("Path is not a file");
    });

    it("handles paths with dots correctly", async () => {
      // Create a file with dots in path
      await writeFile(join(projectPath, ".env"), "SECRET=value");

      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=.env`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.metadata.path).toBe(".env");
      expect(json.content).toBe("SECRET=value");
    });
  });

  describe("GET /api/projects/:projectId/files/raw", () => {
    it("returns raw text file with correct content-type", async () => {
      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files/raw?path=README.md`,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/markdown");
      expect(res.headers.get("Content-Disposition")).toContain("README.md");
      const text = await res.text();
      expect(text).toBe("# Test Project\n\nThis is a test.");
    });

    it("returns raw TypeScript file with correct content-type", async () => {
      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files/raw?path=src/index.ts`,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/typescript");
      const text = await res.text();
      expect(text).toBe('console.log("Hello, world!");');
    });

    it("returns raw binary file with correct content-type", async () => {
      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files/raw?path=image.png`,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/png");
      const buffer = await res.arrayBuffer();
      expect(buffer.byteLength).toBe(8);
    });

    it("sets attachment disposition when download=true", async () => {
      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files/raw?path=README.md&download=true`,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Disposition")).toContain("attachment");
      expect(res.headers.get("Content-Disposition")).toContain("README.md");
    });

    it("sets inline disposition by default", async () => {
      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files/raw?path=README.md`,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Disposition")).toContain("inline");
    });

    it("returns raw content for an absolute live file path", async () => {
      const outsideDir = join(testDir, "outside");
      const outsideFile = join(outsideDir, "raw-notes.txt");
      await mkdir(outsideDir, { recursive: true });
      await writeFile(outsideFile, "outside raw notes");

      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files/raw?path=${encodeURIComponent(outsideFile)}`,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/plain");
      expect(await res.text()).toBe("outside raw notes");
    });

    it("returns 400 for path traversal attempt", async () => {
      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files/raw?path=../../../etc/passwd`,
      );

      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("Invalid file path");
    });

    it("returns 400 for symlink escaping project root", async () => {
      const outsideDir = join(testDir, "outside");
      const outsideFile = join(outsideDir, "secret.txt");
      const linkPath = join(projectPath, "outside-link.txt");
      await mkdir(outsideDir, { recursive: true });
      await writeFile(outsideFile, "outside secret");
      await symlink(outsideFile, linkPath);

      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files/raw?path=outside-link.txt`,
      );

      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("Invalid file path");
    });

    it("returns 404 for non-existent file", async () => {
      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files/raw?path=nonexistent.txt`,
      );

      expect(res.status).toBe(404);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("File not found");
    });
  });

  describe("MIME type detection", () => {
    it.each([
      ["file.ts", "text/typescript"],
      ["file.tsx", "text/typescript"],
      ["file.js", "text/javascript"],
      ["file.jsx", "text/javascript"],
      ["file.json", "application/json"],
      ["file.css", "text/css"],
      ["file.html", "text/html"],
      ["file.py", "text/x-python"],
      ["file.go", "text/x-go"],
      ["file.rs", "text/x-rust"],
      ["file.svg", "image/svg+xml"],
      ["file.jpg", "image/jpeg"],
      ["file.png", "image/png"],
      ["file.gif", "image/gif"],
      ["file.webp", "image/webp"],
      ["file.pdf", "application/pdf"],
      ["file.unknown", "application/octet-stream"],
    ])("detects correct MIME type for %s", async (filename, expectedMime) => {
      // Create the file
      await writeFile(join(projectPath, filename), "test content");

      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=${filename}`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.metadata.mimeType).toBe(expectedMime);
    });
  });

  describe("text file detection", () => {
    it.each([
      ["file.ts", true],
      ["file.md", true],
      ["file.json", true],
      ["file.svg", true],
      ["file.png", false],
      ["file.jpg", false],
      ["file.pdf", false],
      ["file.zip", false],
    ])("correctly identifies %s as text=%s", async (filename, isText) => {
      await writeFile(join(projectPath, filename), "test content");

      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=${filename}`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.metadata.isText).toBe(isText);
    });
  });

  describe("large file handling", () => {
    it("omits content for files over 1MB", async () => {
      // Create a file larger than 1MB
      const largeContent = "x".repeat(1024 * 1024 + 1);
      await writeFile(join(projectPath, "large.txt"), largeContent);

      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=large.txt`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.metadata.isText).toBe(true);
      expect(json.metadata.size).toBeGreaterThan(1024 * 1024);
      expect(json.content).toBeUndefined();
      expect(json.rawUrl).toBeDefined();
    });

    it("returns only requested lines for compact range views", async () => {
      await writeFile(
        join(projectPath, "range.ts"),
        ["const one = 1;", "const two = 2;", "const three = 3;"].join("\n"),
      );

      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=range.ts&line=2&lineEnd=3&view=range&highlight=true`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.content).toBe("const two = 2;\nconst three = 3;");
      expect(json.contentStartLine).toBe(2);
      expect(json.contentEndLine).toBe(3);
      expect(json.contentTotalLines).toBe(3);
      expect(json.contentTruncated).toBe(true);
      expect(json.highlightedHtml).toBeDefined();
    });

    it("returns a bounded window around requested lines in large files", async () => {
      const lines = Array.from(
        { length: 1600 },
        (_, index) =>
          `const line${String(index + 1).padStart(4, "0")} = ` +
          `"${"x".repeat(880)}";`,
      );
      await writeFile(join(projectPath, "large.ts"), lines.join("\n"));

      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files?path=large.ts&line=1200&lineEnd=1202&highlight=true`,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileContentResponse;
      expect(json.metadata.isText).toBe(true);
      expect(json.contentTruncated).toBe(true);
      expect(json.contentStartLine).toBeGreaterThan(1);
      expect(json.contentStartLine).toBeLessThanOrEqual(1200);
      expect(json.contentEndLine).toBeGreaterThanOrEqual(1202);
      expect(Buffer.byteLength(json.content ?? "", "utf8")).toBeLessThanOrEqual(
        1024 * 1024,
      );
      expect(json.content).toContain("1200 ");
      expect(json.content).toContain("1202 ");
      expect(json.highlightedHtml).toBeDefined();
    });

    it("raw endpoint still returns large files", async () => {
      // Create a file larger than 1MB
      const largeContent = "x".repeat(1024 * 1024 + 1);
      await writeFile(join(projectPath, "large.txt"), largeContent);

      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: join(testDir, "sessions"),
      });

      const res = await app.request(
        `/api/projects/${projectId}/files/raw?path=large.txt`,
      );

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text.length).toBeGreaterThan(1024 * 1024);
    });
  });
});
