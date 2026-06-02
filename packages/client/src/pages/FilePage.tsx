import { Link, useParams, useSearchParams } from "react-router-dom";
import { FileViewer } from "../components/FileViewer";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";

/**
 * FilePage - Standalone page for viewing files.
 * Route: /projects/:projectId/file?path=<path>
 */
export function FilePage() {
  const { t } = useI18n();
  const basePath = useRemoteBasePath();
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams] = useSearchParams();
  const filePath = searchParams.get("path");
  const lineNumber = parsePositiveInteger(searchParams.get("line"));
  const lineEnd = parsePositiveInteger(searchParams.get("lineEnd"));

  if (!projectId) {
    return (
      <div className="file-page file-page-error">
        <div className="file-page-error-content">
          <h1>{t("fileInvalidUrl" as never)}</h1>
          <p>{t("fileMissingProjectId" as never)}</p>
          <Link to={`${basePath}/projects`} className="file-page-back-link">
            {t("fileGoToProjects" as never)}
          </Link>
        </div>
      </div>
    );
  }

  if (!filePath) {
    return (
      <div className="file-page file-page-error">
        <div className="file-page-error-content">
          <h1>{t("fileInvalidUrl" as never)}</h1>
          <p>{t("fileMissingPath" as never)}</p>
          <Link
            to={`${basePath}/projects/${projectId}`}
            className="file-page-back-link"
          >
            {t("fileGoToProject" as never)}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="file-page">
      <div className="file-page-nav">
        <Link
          to={`${basePath}/projects/${projectId}`}
          className="file-page-back-link"
          title={t("fileBackToProject" as never)}
        >
          <BackIcon />
          <span>{t("fileBackToProject" as never)}</span>
        </Link>
      </div>
      <div className="file-page-content">
        <FileViewer
          projectId={projectId}
          filePath={filePath}
          lineNumber={lineNumber}
          lineEnd={lineEnd}
          standalone
        />
      </div>
    </div>
  );
}

function parsePositiveInteger(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return undefined;
  }
  return parsed;
}

function BackIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 12L6 8l4-4" />
    </svg>
  );
}
