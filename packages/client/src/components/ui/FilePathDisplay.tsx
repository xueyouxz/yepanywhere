import { splitDisplayPath } from "../../lib/text";

interface FilePathDisplayProps {
  displayPath: string;
}

export function FilePathDisplay({ displayPath }: FilePathDisplayProps) {
  const { dir, name } = splitDisplayPath(displayPath);
  return (
    <span className="file-path-display" title={displayPath}>
      {dir && <span className="file-path-display-dir">{dir}</span>}
      <span className="file-path-display-name">{name}</span>
    </span>
  );
}
