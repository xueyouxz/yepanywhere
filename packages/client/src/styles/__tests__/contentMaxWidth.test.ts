// @vitest-environment node

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const stylesheetUrl = new URL("../index.css", import.meta.url);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readStylesheet(): Promise<string> {
  return readFile(stylesheetUrl, "utf8");
}

function getRuleDeclarations(css: string, selector: string): string {
  const match = new RegExp(`${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`).exec(
    css,
  );
  expect(
    match,
    `${selector} should have a dedicated rule in index.css so the content-width preference is hard to audit.`,
  ).not.toBeNull();
  return match?.[1] ?? "";
}

function expectNormalSessionSelectorUsesContentWidth(
  css: string,
  selector: string,
): void {
  const declarations = getRuleDeclarations(css, selector);
  expect(
    declarations,
    `${selector} must respect --content-max-width; otherwise Appearance > Max Content Width becomes a no-op on main sessions.`,
  ).toMatch(/max-width:\s*var\(--content-max-width\)\s*;/);
  expect(
    declarations,
    `${selector} must not widen normal sessions with max-width: none. Keep any wide exception scoped to .session-split-with-aside.`,
  ).not.toMatch(/max-width:\s*none\s*;/);
}

describe("session content width CSS contract", () => {
  it("keeps normal desktop sessions bound to the content-width preference", async () => {
    const css = await readStylesheet();

    expectNormalSessionSelectorUsesContentWidth(
      css,
      ".main-content-constrained .session-messages .message-list",
    );
    expectNormalSessionSelectorUsesContentWidth(
      css,
      ".main-content-constrained .session-input-inner",
    );
  });

  it("keeps the narrow sidebar/mobile shell bound to the content-width preference", async () => {
    const css = await readStylesheet();
    const declarations = getRuleDeclarations(
      css,
      ".main-content-mobile-inner .session-input-inner,\n.main-content-mobile-inner .session-messages .message-list",
    );

    expect(
      declarations,
      "The <1100px shell is also used when the sidebar leaves desktop mode; main sessions must still honor Appearance > Max Content Width there.",
    ).toMatch(/max-width:\s*var\(--content-max-width\)\s*;/);
    expect(
      declarations,
      "The <1100px shell must not widen normal sessions with max-width: none.",
    ).not.toMatch(/max-width:\s*none\s*;/);
  });

  it("keeps the /btw split-pane full-track exception explicit", async () => {
    const css = await readStylesheet();
    const splitOverride = /\.main-content-constrained\s+\.session-split\.session-split-with-aside\s*>\s*\.session-messages\s+\.message-list,\s*\.main-content-constrained\s+\.session-split\.session-split-with-aside\s*>\s*\.session-input\s+\.session-input-inner\s*\{[^}]*max-width:\s*none\s*;/m;

    expect(
      css,
      "If /btw split sessions should stop using the full available track, update this guard with the new intentional contract.",
    ).toMatch(splitOverride);
  });
});
