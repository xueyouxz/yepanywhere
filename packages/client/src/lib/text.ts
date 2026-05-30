export function truncateText(text: string, maxLength = 60): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/**
 * Shorten path by replacing home directory with ~
 */
export function shortenPath(path: string): string {
  const homePatterns = [
    /^\/home\/[^/]+/, // Linux: /home/username
    /^\/Users\/[^/]+/, // macOS: /Users/username
  ];

  for (const pattern of homePatterns) {
    if (pattern.test(path)) {
      return path.replace(pattern, "~");
    }
  }

  return path;
}

/**
 * Return the most readable form of filePath:
 * - project-relative if the file is under projectPath (e.g. "src/foo.ts")
 * - ~/… relative if the file is under the home directory
 * - absolute path otherwise
 */
export function makeDisplayPath(
  filePath: string,
  projectPath: string | null | undefined,
): string {
  if (projectPath) {
    const prefix = projectPath.endsWith("/") ? projectPath : `${projectPath}/`;
    if (filePath.startsWith(prefix)) return filePath.slice(prefix.length);
    if (filePath === projectPath) return ".";
  }
  return shortenPath(filePath);
}
