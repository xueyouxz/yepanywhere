import { useOptionalSessionMetadata } from "../contexts/SessionMetadataContext";
import { FilePathDisplay } from "./ui/FilePathDisplay";
import { FilePathLink } from "./FilePathLink";

export function SessionFilePathLink({
  displayPath,
  filePath,
  lineNumber,
}: {
  displayPath: string;
  filePath: string;
  lineNumber?: number;
}) {
  const sessionMetadata = useOptionalSessionMetadata();
  if (sessionMetadata?.projectId) {
    return (
      <FilePathLink
        projectId={sessionMetadata.projectId}
        filePath={filePath}
        displayText={displayPath}
        lineNumber={lineNumber}
      />
    );
  }
  return <FilePathDisplay displayPath={displayPath} />;
}
