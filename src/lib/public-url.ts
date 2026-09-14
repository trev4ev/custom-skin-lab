/**
 * Prefix a root-relative public path with the app basePath (GitHub Pages).
 * Example: with basePath `/custom-skin-lab`, `/starters/ahri.png`
 * becomes `/custom-skin-lab/starters/ahri.png`.
 */
export function publicUrl(path: string): string {
  const base = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");
  if (!path) return base || "/";
  if (/^https?:\/\//i.test(path)) return path;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalized}`;
}
