/** Filesystem-safe display-name slug, preserving the historical naming scheme. */
export function slugifyName(name: string, fallback = "subagent"): string {
  return name.toLowerCase().replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || fallback;
}

/** Herdr names are server-wide, ASCII, letter-prefixed, and at most 32 characters. */
export function toHerdrAgentName(name: string, id?: string): string {
  const slug = slugifyName(name);
  const base = /^[a-z]/.test(slug) ? slug : `agent-${slug}`;
  const suffix = id ? "-" + id.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 4) : "";
  return base.slice(0, 32 - suffix.length).replace(/-+$/, "") + suffix;
}
