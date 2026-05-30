import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  RenderModeProvider,
  useOptionalRenderModeContext,
} from "../RenderModeContext";
import { FixedFontMathToggle } from "../../components/ui/FixedFontMathToggle";

function GlobalControls() {
  const renderMode = useOptionalRenderModeContext();

  if (!renderMode) {
    return null;
  }

  return (
    <div>
      <span data-testid="global-state">{renderMode.state}</span>
      <button type="button" onClick={renderMode.toggleGlobalMode}>
        Toggle global
      </button>
    </div>
  );
}

function MathPane({
  id,
  sourceText,
}: {
  id: string;
  sourceText: string;
}) {
  return (
    <div data-testid={id}>
      <FixedFontMathToggle
        sourceText={sourceText}
        sourceView={<pre data-testid={`${id}-source`}>{sourceText}</pre>}
        renderRenderedView={(html) => (
          <div
            data-testid={`${id}-rendered`}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: test harness mirrors production KaTeX rendering
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      />
    </div>
  );
}

describe("RenderModeProvider", () => {
  afterEach(() => {
    cleanup();
  });

  it("tracks mixed local overrides and clears them when toggled globally", () => {
    render(
      <RenderModeProvider>
        <GlobalControls />
        <MathPane id="first" sourceText={"alpha $x^2$ omega"} />
      </RenderModeProvider>,
    );

    expect(screen.getByTestId("global-state").textContent).toBe("rendered");
    expect(screen.getByTestId("first-rendered")).toBeDefined();

    fireEvent.click(
      within(screen.getByTestId("first")).getByRole("button", {
        name: "Show source",
      }),
    );

    expect(screen.getByTestId("global-state").textContent).toBe("mixed");
    expect(screen.getByTestId("first-source")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Toggle global" }));

    expect(screen.getByTestId("global-state").textContent).toBe("source");
    expect(screen.getByTestId("first-source")).toBeDefined();
  });

  it("lets fresh panes follow the base mode even while existing ones are mixed", () => {
    const view = render(
      <RenderModeProvider>
        <GlobalControls />
        <MathPane id="first" sourceText={"alpha $x^2$ omega"} />
      </RenderModeProvider>,
    );

    fireEvent.click(
      within(screen.getByTestId("first")).getByRole("button", {
        name: "Show source",
      }),
    );

    expect(screen.getByTestId("global-state").textContent).toBe("mixed");

    view.rerender(
      <RenderModeProvider>
        <GlobalControls />
        <MathPane id="first" sourceText={"alpha $x^2$ omega"} />
        <MathPane id="second" sourceText={"beta $y^2$ gamma"} />
      </RenderModeProvider>,
    );

    expect(screen.getByTestId("global-state").textContent).toBe("mixed");
    expect(screen.getByTestId("first-source")).toBeDefined();
    expect(screen.getByTestId("second-rendered")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Toggle global" }));

    expect(screen.getByTestId("global-state").textContent).toBe("source");

    view.rerender(
      <RenderModeProvider>
        <GlobalControls />
        <MathPane id="first" sourceText={"alpha $x^2$ omega"} />
        <MathPane id="second" sourceText={"beta $y^2$ gamma"} />
        <MathPane id="third" sourceText={"delta $z^2$ epsilon"} />
      </RenderModeProvider>,
    );

    expect(screen.getByTestId("third-source")).toBeDefined();
  });

  it("supports the session hotkey and clears local overrides incrementally", () => {
    render(
      <RenderModeProvider>
        <GlobalControls />
        <MathPane id="first" sourceText={"alpha $x^2$ omega"} />
      </RenderModeProvider>,
    );

    fireEvent.click(
      within(screen.getByTestId("first")).getByRole("button", {
        name: "Show source",
      }),
    );

    expect(screen.getByTestId("global-state").textContent).toBe("mixed");

    fireEvent.keyDown(window, {
      key: "M",
      ctrlKey: true,
      shiftKey: true,
    });

    expect(screen.getByTestId("global-state").textContent).toBe("source");
    expect(screen.getByTestId("first-source")).toBeDefined();

    fireEvent.keyDown(window, {
      key: "M",
      ctrlKey: true,
      shiftKey: true,
    });

    expect(screen.getByTestId("global-state").textContent).toBe("rendered");
    expect(screen.getByTestId("first-rendered")).toBeDefined();
  });

  it("renders markdown tables without losing diff prefixes", () => {
    const sourceText = [
      " | name | value |",
      " | --- | --- |",
      "-| old | $x^2$ |",
      "+| new | $y^2$ |",
    ].join("\n");

    const { container } = render(
      <RenderModeProvider>
        <MathPane id="diff-table" sourceText={sourceText} />
      </RenderModeProvider>,
    );

    expect(screen.getByRole("table")).toBeDefined();
    expect(screen.getByText("old")).toBeDefined();
    expect(screen.getByText("new")).toBeDefined();
    const gutters = Array.from(
      container.querySelectorAll(".fixed-font-diff-gutter"),
    ).map((node) => node.textContent);
    expect(gutters).toContain("-");
    expect(gutters).toContain("+");
    expect(container.querySelector(".katex")).toBeTruthy();

    fireEvent.click(
      within(screen.getByTestId("diff-table")).getByRole("button", {
        name: "Show source",
      }),
    );

    expect(screen.getByTestId("diff-table-source").textContent).toContain(
      "-| old | $x^2$ |",
    );
  });

  it("detects markdown tables in ANSI-colored unified diffs", () => {
    const sourceText = [
      "\u001b[1mdiff --git a/notes.md b/notes.md\u001b[0m",
      "@@ -1,4 +1,4 @@",
      " | name | value |",
      " | --- | --- |",
      "\u001b[31m-| old | $x^2$ |\u001b[0m",
      "\u001b[32m+| new | $y^2$ |\u001b[0m",
    ].join("\n");

    const { container } = render(
      <RenderModeProvider>
        <MathPane id="ansi-diff-table" sourceText={sourceText} />
      </RenderModeProvider>,
    );

    expect(screen.getByRole("table")).toBeDefined();
    expect(screen.getByText("old")).toBeDefined();
    expect(screen.getByText("new")).toBeDefined();
    const gutters = Array.from(
      container.querySelectorAll(".fixed-font-diff-gutter"),
    ).map((node) => node.textContent);
    expect(gutters).toContain("-");
    expect(gutters).toContain("+");
  });

  it("compensates fixed-column list continuation indents in rendered diffs", () => {
    const sourceText = [
      "@@ -1,1 +1,2 @@",
      "-old",
      "+  - Version keyword: include `INCREMENT_PATCH_VERSION` on its own line in",
      "+    the commit body, immediately before the `Change-Id` trailer.",
    ].join("\n");

    const { container } = render(
      <RenderModeProvider>
        <MathPane id="diff-list-wrap" sourceText={sourceText} />
      </RenderModeProvider>,
    );

    const listContent = container.querySelector(
      ".fixed-font-markdown-list-line .fixed-font-rendered-line__content",
    );
    expect(listContent?.getAttribute("style")).toContain(
      "--fixed-font-list-indent-ch:2",
    );
    expect(listContent?.getAttribute("style")).toContain(
      "--fixed-font-list-marker-ch:2",
    );

    const continuationIndent = container.querySelector(
      ".fixed-font-leading-indent",
    );
    expect(continuationIndent?.getAttribute("style")).toContain(
      "--fixed-font-leading-ch:4",
    );
    expect(screen.getByText(/the commit body/)).toBeDefined();
  });
});
