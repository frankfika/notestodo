import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import JSZip from "jszip";

export async function zipMemoryTree(memoryRoot: string): Promise<Buffer> {
  const zip = new JSZip();
  addDir(zip, memoryRoot, memoryRoot);
  const data = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return data;
}

function addDir(zip: JSZip, root: string, current: string): void {
  if (!existsSync(current)) return;
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      addDir(zip, root, absolute);
    } else if (entry.isFile()) {
      zip.file(relative, readFileSync(absolute));
    } else if (statSync(absolute).isFile()) {
      zip.file(relative, readFileSync(absolute));
    }
  }
}
