import { Button } from "@huoye/ui";
import { hasDesktopFolderPicker } from "../lib/desktop-folder-picker";

export function FolderBrowseButton({
  desktop,
  onPicked,
  disabled,
}: {
  desktop?: unknown;
  onPicked: (path: string) => void;
  disabled?: boolean;
}) {
  if (!hasDesktopFolderPicker(desktop)) return null;

  async function pick() {
    if (!hasDesktopFolderPicker(desktop)) return;
    const picked = await desktop.pickLocalFolder();
    if (picked) onPicked(picked);
  }

  return (
    <Button tone="ghost" type="button" onClick={() => void pick()} disabled={disabled}>
      浏览…
    </Button>
  );
}
