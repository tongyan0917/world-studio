import { hash } from "../kernel/stable.ts";
import type { StudioWikiPage } from "./types.ts";

export interface SaveWikiPageInput {
  readonly slug: string;
  readonly title: string;
  readonly markdown: string;
  readonly tags?: readonly string[];
}

export function normalizeWikiSlug(value: string): string {
  const slug = value.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("Wiki slug must contain a letter or number");
  return slug;
}

export function extractWikiLinks(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(/\[\[([^\]\n]{1,160})\]\]/g)].map((match) => match[1]!.trim()).filter(Boolean))].sort();
}

export function extractWikiTags(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu)].map((match) => match[1]!.toLowerCase()))].sort();
}

export function wikiPageContentHash(page: Pick<StudioWikiPage, "worldId" | "id" | "slug" | "title" | "markdown" | "tags" | "links">): string {
  return hash({
    worldId: page.worldId,
    id: page.id,
    slug: page.slug,
    title: page.title,
    markdown: page.markdown,
    tags: page.tags,
    links: page.links,
  });
}

export function createWikiPage(worldId: string, input: SaveWikiPageInput, revision: number): StudioWikiPage {
  if (!worldId.startsWith("world.")) throw new Error("Wiki page requires a valid World id");
  if (!input.title.trim()) throw new Error("Wiki title is required");
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Wiki revision must be a positive integer");
  const slug = normalizeWikiSlug(input.slug || input.title);
  const core = {
    worldId,
    id: `wiki:${worldId}:${slug}`,
    slug,
    title: input.title.trim(),
    markdown: input.markdown,
    tags: [...new Set([...(input.tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean), ...extractWikiTags(input.markdown)])].sort(),
    links: extractWikiLinks(input.markdown),
  } as const;
  return Object.freeze({ ...core, revision, contentHash: wikiPageContentHash(core) });
}
