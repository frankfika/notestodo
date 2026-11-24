/** 把记忆相对路径转成页面路由，日记和健康记录不会带上第二个 .md。 */
export function memoryHref(relativePath: string): string {
  const posix = (relativePath ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  const diary = posix.match(/^diaries\/([^/]+)$/i);
  if (diary) {
    const date = diary[1].replace(/\.md$/i, "");
    return `/memories/diaries/${date}`;
  }
  const health = posix.match(/^health\/([^/]+)$/i);
  if (health) {
    const date = health[1].replace(/\.md$/i, "");
    return `/memories/health/${date}`;
  }
  const recording = posix.match(/^recordings\/([^/]+)$/i);
  if (recording) {
    const id = recording[1].replace(/\.md$/i, "");
    return `/memories/recordings/${id}`;
  }
  return `/memories/${posix}`;
}

/** 从日记日期参数或 /memories/* 路径还原记忆文件的相对路径。 */
export function memoryPathFromRoute(
  params: { date?: string },
  pathname: string,
): string {
  if (params.date) {
    const date = params.date.replace(/\.md$/i, "");
    return `diaries/${date}.md`;
  }
  const health = pathname.match(/\/memories\/health\/([^/]+)$/);
  if (health) {
    const date = decodeURIComponent(health[1]).replace(/\.md$/i, "");
    return `health/${date}.md`;
  }
  const recording = pathname.match(/\/memories\/recordings\/([^/]+)$/);
  if (recording) {
    const id = decodeURIComponent(recording[1]).replace(/\.md$/i, "");
    return `recordings/${id}.md`;
  }
  return decodeURIComponent(pathname.replace(/^\/memories\//, ""));
}
