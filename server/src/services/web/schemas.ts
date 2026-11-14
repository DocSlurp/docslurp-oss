import { CHART_EXPORT_OVERRIDE_DESCRIPTION, chartExportOverrideSchema } from "@docslurp/shared";
import { z } from "zod";

const httpUrl = z.url().max(2_048).refine((url) => /^https?:\/\//i.test(url), "Use HTTP or HTTPS URLs");
const domain = z.string().trim().min(3).max(253).regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, "Use a bare domain such as example.com");
const pathPattern = z.string().min(1).max(200);
const project = z.string().min(1).max(256).optional()
  .describe("Project whose privacy and billing settings apply. Omit for the organization default project.");
const depth = z.enum(["fast", "deep"]).default("fast")
  .describe("fast: cheapest mode. deep: higher-quality results or a fresh browser render; costs more.");

export const webSearchInput = z.object({
  query: z.string().trim().min(1).max(400).describe("What to search the public web for."),
  limit: z.number().int().min(1).max(10).default(5),
  depth,
  includeContent: z.boolean().default(false).describe("Also return each result's page Markdown. Counts as a deep search."),
  includeDomains: z.array(domain).max(20).optional(),
  excludeDomains: z.array(domain).max(20).optional(),
  recency: z.enum(["day", "week", "month", "year"]).optional().describe("Only pages published within this period."),
  maxCharacters: z.number().int().min(500).max(50_000).default(8_000).describe("Per-page Markdown cap when includeContent is set."),
  project,
}).strict();

export const webFetchInput = z.object({
  urls: z.array(httpUrl).min(1).max(10).refine((urls) => new Set(urls).size === urls.length, "URLs must be unique")
    .describe("Public HTTP(S) pages to read as Markdown."),
  depth,
  maxCharacters: z.number().int().min(500).max(100_000).default(20_000).describe("Per-page Markdown cap."),
  project,
}).strict();

export const webMapInput = z.object({
  url: httpUrl.describe("Site or section to list URLs for."),
  limit: z.number().int().min(1).max(500).default(100),
  search: z.string().trim().min(1).max(200).optional().describe("Rank discovered URLs by relevance to this text."),
  includeSubdomains: z.boolean().default(false),
  project,
}).strict();

export const webCrawlInput = z.object({
  url: httpUrl.describe("Start page. The crawl stays on this site."),
  limit: z.number().int().min(1).max(100).default(10).describe("Maximum pages to read."),
  maxDepth: z.number().int().min(1).max(3).default(2).describe("Link hops from the start page."),
  includePaths: z.array(pathPattern).max(20).optional().describe("Only crawl paths matching these regular expressions, e.g. ^/docs/.*"),
  excludePaths: z.array(pathPattern).max(20).optional().describe("Skip paths matching these regular expressions."),
  maxCharacters: z.number().int().min(500).max(100_000).default(20_000).describe("Per-page Markdown cap."),
  timeoutSeconds: z.number().int().min(15).max(170).default(120).describe("Stop waiting after this long and return the pages read so far."),
  project,
}).strict();

export const ingestWebsiteInput = webCrawlInput.omit({ maxCharacters: true, project: true }).extend({
  project: z.string().min(1).max(256).optional().describe("Project ID, slug or name to ingest into. A name that matches no project creates it. Omit for the default project."),
  newProject: z.boolean().optional().describe("Without project: ingest into a fresh self-titled project."),
  tags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  /** The same per-request chart export override uploads take (`{ tier }`); refused when the deployment does not offer it. */
  chartExport: chartExportOverrideSchema.optional().describe(CHART_EXPORT_OVERRIDE_DESCRIPTION),
}).strict();

export type WebSearchRequest = z.infer<typeof webSearchInput>;
export type WebFetchRequest = z.infer<typeof webFetchInput>;
export type WebMapRequest = z.infer<typeof webMapInput>;
export type WebCrawlRequest = z.infer<typeof webCrawlInput>;
export type IngestWebsiteRequest = z.infer<typeof ingestWebsiteInput>;
