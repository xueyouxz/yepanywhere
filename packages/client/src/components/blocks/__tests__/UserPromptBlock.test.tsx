import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../i18n";
import { useRemoteImage } from "../../../hooks/useRemoteImage";
import type { ContentBlock } from "../../../types";
import { UserPromptBlock } from "../UserPromptBlock";

vi.mock("../../../hooks/useRemoteImage", () => ({
  useRemoteImage: vi.fn(() => ({ url: null, loading: false, error: null })),
}));

describe("UserPromptBlock", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders Codex input_image blocks as uploaded file metadata", () => {
    const content: ContentBlock[] = [
      {
        type: "text",
        text: "Please review this screenshot.\n<image>\nThanks.",
      },
      {
        type: "input_image",
        image_url: "data:image/png;base64,AAAA",
      },
    ];

    render(
      <I18nProvider>
        <UserPromptBlock content={content} />
      </I18nProvider>,
    );

    expect(screen.getByText(/Please review this screenshot\./)).toBeDefined();
    expect(screen.getByText(/Thanks\./)).toBeDefined();
    expect(screen.queryByText("<image>")).toBeNull();
    expect(screen.getByText(/pasted-image-1\.png/)).toBeDefined();
    expect(screen.queryByText(/data:image\/png;base64/i)).toBeNull();
  });

  it("opens preview modal for Codex inline input_image attachments", () => {
    const content: ContentBlock[] = [
      {
        type: "text",
        text: "Please review this screenshot.\n<image>\nThanks.",
      },
      {
        type: "input_image",
        image_url: "data:image/png;base64,AAAA",
      },
    ];

    render(
      <I18nProvider>
        <UserPromptBlock content={content} />
      </I18nProvider>,
    );

    const attachmentButton = screen.getByRole("button", {
      name: /pasted-image-1\.png/i,
    });
    fireEvent.click(attachmentButton);

    expect(
      screen.getByRole("img", { name: /pasted-image-1\.png/i }),
    ).toBeDefined();
  });

  it("uses file_path name for Codex input_image attachments", () => {
    const content: ContentBlock[] = [
      {
        type: "text",
        text: "Annotated image:\n<image>",
      },
      {
        type: "input_image",
        file_path: "/tmp/codex-images/annotated-shot.jpg",
      },
    ];

    render(
      <I18nProvider>
        <UserPromptBlock content={content} />
      </I18nProvider>,
    );

    expect(screen.getByText(/Annotated image:/)).toBeDefined();
    expect(screen.queryByText("<image>")).toBeNull();
    expect(screen.getByText(/annotated-shot\.jpg/)).toBeDefined();
  });

  it("does not fetch uploaded image previews until opened", async () => {
    const remotePath =
      "/api/projects/proj/sessions/session/upload/123e4567-e89b-12d3-a456-426614174000_photo.jpg";
    const content: ContentBlock[] = [
      {
        type: "text",
        text: "Attached image:\n<image>",
      },
      {
        type: "input_image",
        file_path:
          "/home/graehl/.yep-anywhere/uploads/proj/session/123e4567-e89b-12d3-a456-426614174000_photo.jpg",
      },
    ];

    render(
      <I18nProvider>
        <UserPromptBlock content={content} />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(useRemoteImage).toHaveBeenCalledWith(remotePath, false);
    });
    expect(useRemoteImage).not.toHaveBeenCalledWith(remotePath, true);

    fireEvent.click(screen.getByRole("button", { name: /photo\.jpg/i }));

    await waitFor(() => {
      expect(useRemoteImage).toHaveBeenCalledWith(remotePath, true);
    });
  });
});
