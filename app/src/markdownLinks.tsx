import type { MouseEvent, AnchorHTMLAttributes, ReactNode } from "react";

function isExternalHref(href: string): boolean {
  return /^(https?:|mailto:|tel:)/i.test(href);
}

export async function openMarkdownHref(href: string): Promise<void> {
  if (isExternalHref(href)) {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(href);
    } catch {
      window.open(href, "_blank", "noopener,noreferrer");
    }
    return;
  }

  if (href.startsWith("#")) {
    const id = decodeURIComponent(href.slice(1));
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  // Relative paths (other notes, assets, etc.) stay in-app — never navigate the webview.
}

export function MarkdownAnchor({
  href,
  children,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { children?: ReactNode }) {
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (href) void openMarkdownHref(href);
      }}
    >
      {children}
    </a>
  );
}

/** Capture clicks on links inside MDXEditor or other rich surfaces. */
export function onMarkdownLinkClickCapture(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  const anchor = target?.closest?.("a");
  if (!anchor) return;
  const href = anchor.getAttribute("href");
  if (!href) return;
  event.preventDefault();
  event.stopPropagation();
  void openMarkdownHref(href);
}
