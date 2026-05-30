// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { Project } from "../../types";
import { ProjectCard } from "../ProjectCard";

const project: Project = {
  id: "proj-1",
  name: "test-project",
  path: "/tmp/test-project",
  sessionCount: 0,
  activeOwnedCount: 0,
  activeExternalCount: 0,
  lastActivity: null,
};

function renderProjectCard(onDeleteProject = vi.fn()) {
  return render(
    <I18nProvider>
      <MemoryRouter>
        <ProjectCard
          project={project}
          needsAttentionCount={0}
          thinkingCount={0}
          onDeleteProject={onDeleteProject}
        />
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("ProjectCard", () => {
  afterEach(() => {
    cleanup();
  });

  it("offers a project removal action", () => {
    const onDeleteProject = vi.fn();
    renderProjectCard(onDeleteProject);

    fireEvent.click(screen.getByRole("button", { name: "Remove project" }));

    expect(onDeleteProject).toHaveBeenCalledWith(project);
  });
});
