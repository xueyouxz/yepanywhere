import type { ProviderName } from "@yep-anywhere/shared";
import { useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { NewSessionForm } from "../components/NewSessionForm";
import { PageHeader } from "../components/PageHeader";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useProject, useProjects } from "../hooks/useProjects";
import {
  getRecentProjectId,
  resolvePreferredProjectId,
  setRecentProjectId,
} from "../hooks/useRecentProject";
import { useRecentSessions } from "../hooks/useRecentSessions";
import { useI18n } from "../i18n";
import { MainContent, useNavigationLayout } from "../layouts";

const RECENT_PROJECT_SESSION_LIMIT = 30;
const DETACHED_PROJECT_PARAM = "detached";

export function NewSessionPage() {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = searchParams.get("projectId") ?? undefined;
  const preferredProvider = searchParams.get("provider") ?? undefined;
  const preferredModel = searchParams.get("model") ?? undefined;
  const requestedDetached =
    !projectId && searchParams.get(DETACHED_PROJECT_PARAM) === "1";
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();

  const { projects, loading: projectsLoading } = useProjects();
  const { recentSessions, isLoading: recentSessionsLoading } =
    useRecentSessions({
      limit: RECENT_PROJECT_SESSION_LIMIT,
    });
  const { project, loading: projectLoading, error } = useProject(projectId);
  const selectedProject =
    (projectId
      ? projects.find((candidate) => candidate.id === projectId)
      : null) ?? project;
  const recentProjectIds = useMemo(
    () =>
      Array.from(new Set(recentSessions.map((session) => session.projectId))),
    [recentSessions],
  );

  // Update browser tab title (must be called unconditionally before any early returns)
  useDocumentTitle(selectedProject?.name, t("newSessionTitle"));

  useEffect(() => {
    if (!projectId || !selectedProject) return;
    setRecentProjectId(projectId);
  }, [projectId, selectedProject]);

  useEffect(() => {
    if (
      projectId ||
      requestedDetached ||
      projectsLoading ||
      projects.length === 0
    ) {
      return;
    }

    const storedRecentProjectId = getRecentProjectId();
    const hasValidStoredRecentProject = Boolean(
      storedRecentProjectId &&
        projects.some((project) => project.id === storedRecentProjectId),
    );
    if (recentSessionsLoading && !hasValidStoredRecentProject) {
      return;
    }

    const preferredProjectId = resolvePreferredProjectId(
      projects,
      recentProjectIds[0],
    );
    if (!preferredProjectId) {
      return;
    }

    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("projectId", preferredProjectId);
    nextParams.delete(DETACHED_PROJECT_PARAM);
    setSearchParams(nextParams, { replace: true });
  }, [
    projectId,
    projects,
    projectsLoading,
    recentProjectIds,
    recentSessionsLoading,
    requestedDetached,
    searchParams,
    setSearchParams,
  ]);

  // Callback to update projectId in URL without navigation
  const handleProjectChange = (newProjectId: string | null) => {
    const nextParams = new URLSearchParams(searchParams);
    if (newProjectId) {
      nextParams.set("projectId", newProjectId);
      nextParams.delete(DETACHED_PROJECT_PARAM);
      setRecentProjectId(newProjectId);
    } else {
      nextParams.delete("projectId");
      nextParams.set(DETACHED_PROJECT_PARAM, "1");
    }
    setSearchParams(nextParams, { replace: true });
  };

  const loading = Boolean(projectId) && projectLoading && !selectedProject;
  const renderError = !selectedProject ? error : null;

  // Render loading/error states
  if (loading || renderError) {
    return (
      <MainContent isWideScreen={isWideScreen}>
        <PageHeader
          title={t("newSessionTitle")}
          onOpenSidebar={openSidebar}
          onToggleSidebar={toggleSidebar}
          isWideScreen={isWideScreen}
          isSidebarCollapsed={isSidebarCollapsed}
        />
        <main className="page-scroll-container">
          <div className="page-content-inner">
            {loading ? (
              <div className="loading">{t("newSessionLoading")}</div>
            ) : (
              <div className="error">
                {t("newSessionErrorPrefix")} {renderError?.message}
              </div>
            )}
          </div>
        </main>
      </MainContent>
    );
  }

  return (
    <MainContent isWideScreen={isWideScreen}>
      <PageHeader
        title={t("newSessionTitle")}
        onOpenSidebar={openSidebar}
        onToggleSidebar={toggleSidebar}
        isWideScreen={isWideScreen}
        isSidebarCollapsed={isSidebarCollapsed}
      />

      <main className="page-scroll-container">
        <div className="page-content-inner new-session-page-shell">
          <NewSessionForm
            projectId={projectId}
            selectedProject={selectedProject}
            projects={projects}
            recentProjectIds={recentProjectIds}
            projectsLoading={projectsLoading}
            onProjectChange={handleProjectChange}
            preferredProvider={preferredProvider as ProviderName | undefined}
            preferredModel={preferredModel}
          />
        </div>
      </main>
    </MainContent>
  );
}
