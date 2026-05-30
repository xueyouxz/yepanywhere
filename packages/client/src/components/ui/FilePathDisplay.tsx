interface FilePathDisplayProps {
  displayPath: string;
}

export function FilePathDisplay({ displayPath }: FilePathDisplayProps) {
  const lastSlash = displayPath.lastIndexOf("/");
  const dir = lastSlash >= 0 ? displayPath.slice(0, lastSlash + 1) : "";
  const name = lastSlash >= 0 ? displayPath.slice(lastSlash + 1) : displayPath;
  return (
    <span className="file-path-display" title={displayPath}>
      {dir && <span className="file-path-display-dir">{dir}</span>}
      <span className="file-path-display-name">{name}</span>
    </span>
  );
}
