import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextBlock } from "../TextBlock";

describe("TextBlock", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("defers local math rendering until streaming text completes", () => {
    const { container, rerender } = render(
      <TextBlock text="Streaming $x^2$ now" isStreaming={true} />,
    );

    expect(container.querySelector(".text-block-toggle")).toBeNull();
    expect(container.querySelector(".text-block-local-rendered")).toBeNull();
    expect(screen.getByText("Streaming $x^2$ now")).toBeDefined();

    rerender(<TextBlock text="Streaming $x^2$ now" isStreaming={false} />);

    expect(container.querySelector(".text-block-toggle")).toBeTruthy();
    expect(container.querySelector(".text-block-local-rendered")).toBeTruthy();
    expect(container.querySelector(".katex")).toBeTruthy();
  });

  it("does not show render toggle for server HTML that matches plain text", () => {
    const { container } = render(
      <TextBlock text="Plain answer." augmentHtml="<p>Plain answer.</p>" />,
    );

    expect(container.querySelector(".text-block-toggle")).toBeNull();
    expect(screen.getByText("Plain answer.")).toBeDefined();
  });

  it("shows render toggle for completed server markdown", () => {
    const { container } = render(
      <TextBlock text="- **win**" augmentHtml="<ul><li><strong>win</strong></li></ul>" />,
    );

    expect(container.querySelector(".text-block-toggle")).toBeTruthy();
    expect(container.querySelector("strong")?.textContent).toBe("win");
  });

  it("mounts local media previews inline beside rendered markdown links", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["png"], { type: "image/png" }))),
    );
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    });

    const { container } = render(
      <TextBlock
        text="[trajectory](/tmp/trajectory.png)"
        augmentHtml={
          '<span class="local-media-link-group"><button type="button" class="local-media-inline-toggle" data-media-path="/tmp/trajectory.png" data-media-type="image" data-expanded="true" aria-label="Collapse image" aria-expanded="true" title="Collapse inline preview">-</button><a href="/api/local-image?path=%2Ftmp%2Ftrajectory.png" class="local-media-link" data-media-type="image">trajectory<span class="local-media-type">(image)</span></a></span><span class="local-media-inline-preview" data-media-path="/tmp/trajectory.png" data-media-type="image" data-expanded="true"></span>'
        }
      />,
    );

    expect(container.querySelector(".local-media-link")).toBeTruthy();
    expect(await screen.findByAltText("trajectory.png")).toBeTruthy();
    expect(
      container.querySelector(".local-media-inline-image-button"),
    ).toBeTruthy();
  });
});
