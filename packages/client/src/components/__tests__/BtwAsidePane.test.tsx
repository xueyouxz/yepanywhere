// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BtwAsidePane, type BtwAsidePaneItem } from "../BtwAsidePane";

function renderPane(
  aside: Partial<BtwAsidePaneItem> = {},
  callbacks: {
    onSendFollowup?: (text: string) => void;
    onHide?: () => void;
    onDone?: (argument: string) => void;
    onTransferToComposer?: (text: string) => void;
  } = {},
) {
  const item: BtwAsidePaneItem = {
    id: "aside-1",
    request: "check side state",
    followUps: [],
    status: "running",
    responses: ["first answer"],
    ...aside,
  };
  const onSendFollowup = vi.fn(callbacks.onSendFollowup);
  const onHide = vi.fn(callbacks.onHide);
  const onDone = vi.fn(callbacks.onDone);
  const onTransferToComposer = vi.fn(callbacks.onTransferToComposer);

  function Harness() {
    const [draft, setDraft] = useState("");
    return (
      <BtwAsidePane
        aside={item}
        draft={draft}
        onDraftChange={setDraft}
        onSendFollowup={onSendFollowup}
        onHide={onHide}
        onDone={onDone}
        onTransferToComposer={onTransferToComposer}
      />
    );
  }

  render(<Harness />);
  return { onSendFollowup, onHide, onDone, onTransferToComposer };
}

describe("BtwAsidePane", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("sends follow-ups, intercepts /done, and separates Hide from Done", () => {
    const { onSendFollowup, onHide, onDone } = renderPane();
    const textarea = screen.getByLabelText(
      "/btw aside composer",
    ) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "look again" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onSendFollowup).toHaveBeenCalledWith("look again");
    expect(textarea.value).toBe("");

    fireEvent.change(textarea, { target: { value: "/done use this" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onDone).toHaveBeenCalledWith("use this");
    expect(onSendFollowup).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Min" }));
    expect(onHide).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onDone).toHaveBeenLastCalledWith("");
    expect(onDone).toHaveBeenCalledTimes(2);
  });

  it("shows ordered turns with copy and Mother composer transfer actions", () => {
    const { onTransferToComposer } = renderPane({
      turns: [
        { id: "request", role: "user", text: "first question" },
        { id: "answer-1", role: "assistant", text: "first answer" },
        { id: "followup", role: "user", text: "follow-up question" },
        { id: "answer-2", role: "assistant", text: "final answer" },
      ],
    });

    expect(screen.getByText("first question")).toBeTruthy();
    expect(screen.getByText("first answer")).toBeTruthy();
    expect(screen.getByText("follow-up question")).toBeTruthy();
    expect(screen.getByText("final answer")).toBeTruthy();

    expect(screen.getAllByLabelText("Copy message text")).toHaveLength(2);
    expect(screen.getAllByLabelText("Copy markdown")).toHaveLength(2);

    fireEvent.click(
      screen.getAllByLabelText(
        "Insert assistant /btw turn into Mother composer",
      )[1] as HTMLElement,
    );
    expect(onTransferToComposer).toHaveBeenCalledWith("final answer");

    fireEvent.click(
      screen.getAllByLabelText(
        "Insert user /btw turn into Mother composer",
      )[0] as HTMLElement,
    );
    expect(onTransferToComposer).toHaveBeenLastCalledWith("first question");
  });
});
