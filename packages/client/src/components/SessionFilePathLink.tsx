import { useOptionalSessionMetadata } from "../contexts/SessionMetadataContext";
import { makeDisplayPath } from "../lib/text";
import { FilePathLink } from "./FilePathLink";
import type { FileViewerMode } from "./FileViewer";
import { FilePathDisplay } from "./ui/FilePathDisplay";

export function SessionFilePathLink({
  displayPath,
  filePath,
  lineEnd,
  lineNumber,
  showLineSuffix,
  viewMode,
}: {
  displayPath?: string;
  filePath: string;
  lineEnd?: number;
  lineNumber?: number;
  showLineSuffix?: boolean;
  viewMode?: FileViewerMode;
}) {
  const sessionMetadata = useOptionalSessionMetadata();
  const resolvedDisplayPath =
    displayPath ?? makeDisplayPath(filePath, sessionMetadata?.projectPath);
  if (sessionMetadata?.projectId) {
    return (
      <FilePathLink
        projectId={sessionMetadata.projectId}
        filePath={filePath}
        displayText={resolvedDisplayPath}
        lineEnd={lineEnd}
        lineNumber={lineNumber}
        showLineSuffix={showLineSuffix}
        viewMode={viewMode}
      />
    );
  }
  return <FilePathDisplay displayPath={resolvedDisplayPath} />;
}
