// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Trigger the browser's save dialog for a text document. The object URL is
// revoked on the next task, after the browser has started the download, so the
// document is never kept alive by the page.
export function downloadTextFile(
  filename: string,
  text: string,
  type = "application/yaml",
): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
