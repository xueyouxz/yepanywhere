// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlashCommandButton } from "../SlashCommandButton";

describe("SlashCommandButton", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows documented slash command words with bold shortcuts", () => {
    render(
      <SlashCommandButton
        commands={["fast", "run", "goal", "compact", "model"]}
        onSelectCommand={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText("Show slash commands"));

    expect(screen.getByRole("menuitem", { name: "/model" }).textContent).toBe(
      "/model",
    );
    expect(
      screen.getByRole("menuitem", { name: "/fast turn" }).textContent,
    ).toBe("/fast turn");
    expect(
      screen.getByRole("menuitem", { name: "/run exactly" }).textContent,
    ).toBe("/run exactly");
    expect(screen.getByRole("menuitem", { name: "/goal" }).textContent).toBe(
      "/goal",
    );
    expect(screen.getByRole("menuitem", { name: "/compact" }).textContent).toBe(
      "/compact",
    );

    const shortcuts = Array.from(
      document.querySelectorAll(".slash-command-shortcut"),
    ).map((node) => node.textContent);
    expect(shortcuts).toEqual(["/f", "/r", "/m"]);
  });

  it("selects the full command word, not the shortcut", () => {
    const onSelectCommand = vi.fn();
    render(
      <SlashCommandButton
        commands={["fast"]}
        onSelectCommand={onSelectCommand}
      />,
    );

    fireEvent.click(screen.getByLabelText("Show slash commands"));
    fireEvent.click(screen.getByRole("menuitem", { name: "/fast turn" }));

    expect(onSelectCommand).toHaveBeenCalledWith("/fast");
  });
});
