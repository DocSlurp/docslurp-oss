import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createOfflineSearchClient,
  type OfflineSearchBundle,
  type OfflineSearchClient,
  type OfflineSearchClientOptions,
  type SearchResult,
} from "./offline-search.js";

type ChatResponse = {
  id: string;
  answer: string;
  citations: Array<{
    citation: { filename: string; pageNumber: number | null };
  }>;
};

type DocumentViewerPayload = {
  document: {
    id: string;
    filename: string;
    pageCount: number;
  };
  artifacts: Array<{ slot: string; url: string; uri: string }>;
  pageStats: {
    pageCount: number;
    chunkCount: number;
  };
};

type BaseEmbedProps = {
  /** Default https://docslurp.io. */
  apiUrl?: string;
  /** Workspace ID, slug or name, or "default" (the key organization's default workspace). Default "default". */
  workspace?: string;
  clientKey?: string;
};

const DEFAULT_API_URL = "https://docslurp.io";
const DEFAULT_WORKSPACE = "default";

type OfflineSearchEmbedOptions = Omit<
  OfflineSearchClientOptions,
  "bundle" | "bundleUrl"
> & {
  bundle?: OfflineSearchBundle;
  bundleUrl?: string;
  client?: OfflineSearchClient;
};

function buildHeaders(clientKey?: string) {
  const headers: Record<string, string> = {};
  if (clientKey) {
    headers.Authorization = `Bearer ${clientKey}`;
  }
  return headers;
}

export function SearchEmbed({
  apiUrl = DEFAULT_API_URL,
  workspace = DEFAULT_WORKSPACE,
  clientKey,
  placeholder = "Search documents...",
  limit = 8,
  offline,
}: BaseEmbedProps & {
  placeholder?: string;
  limit?: number;
  offline?: OfflineSearchEmbedOptions;
}) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [results, setResults] = useState<SearchResult[]>([]);
  const canSearch = useMemo(
    () => q.trim().length > 0 && Boolean(offline || workspace),
    [offline, q, workspace],
  );
  const offlineClient = useMemo(() => {
    if (!offline) {
      return null;
    }
    return offline.client ?? createOfflineSearchClient(offline);
  }, [offline]);

  async function run() {
    if (!canSearch) return;
    setBusy(true);
    setStatus("Searching...");
    try {
      if (offlineClient) {
        const nextResults = await offlineClient.search(q, { limit });
        setResults(nextResults);
        setStatus(`Found ${nextResults.length} results offline`);
      } else if (workspace) {
        const params = new URLSearchParams({
          q,
          workspace,
          limit: String(limit),
        });
        const res = await fetch(
          `${apiUrl.replace(/\/$/, "")}/v1/search?${params.toString()}`,
          {
            headers: buildHeaders(clientKey),
          },
        );
        if (!res.ok) throw new Error("Request failed");
        const json = (await res.json()) as { results: SearchResult[] };
        setResults(json.results);
        setStatus(`Found ${json.results.length} results`);
      }
    } catch (error) {
      setStatus("We couldn’t load search results. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const id = setTimeout(() => {
      void run();
    }, 250);
    return () => clearTimeout(id);
  }, [q, offlineClient, workspace, apiUrl, clientKey, limit]);

  return (
    <div data-docslurp-surface="search" style={surfaceStyle}>
      <style>{embedStyles}</style>
      <input
        aria-label="Search"
        onChange={(event) => setQ(event.target.value)}
        placeholder={placeholder}
        style={inputStyle}
        value={q}
      />
      {status ? (
        <div role="status" aria-live="polite" style={statusStyle}>
          {status}
        </div>
      ) : null}
      {busy ? <SearchWaiting /> : null}
      <div style={stackStyle}>
        {results.map((result, index) => (
          <article
            key={`${result.citation.documentId}:${result.citation.chunkIndex}:${index}`}
            style={cardStyle}
          >
            <div style={bodyStyle}>{result.text}</div>
            <div style={metaStyle}>
              {result.citation.filename} · p.{result.citation.pageNumber ?? "-"}
            </div>
          </article>
        ))}
      </div>
      <button
        disabled={!canSearch || busy}
        onClick={() => void run()}
        style={buttonStyle}
        type="button"
      >
        {busy ? "Searching..." : "Search"}
      </button>
    </div>
  );
}

export function ChatEmbed({
  apiUrl = DEFAULT_API_URL,
  workspace = DEFAULT_WORKSPACE,
  clientKey,
  placeholder = "Ask about this workspace...",
}: BaseEmbedProps & {
  placeholder?: string;
}) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    const text = q.trim();
    if (!text || !workspace) return;
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      const res = await fetch(`${apiUrl.replace(/\/$/, "")}/v1/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildHeaders(clientKey),
        },
        body: JSON.stringify({ q: text, workspace }),
      });
      if (!res.ok) throw new Error("Request failed");
      const json = (await res.json()) as ChatResponse;
      setAnswer(json.answer);
    } catch (err) {
      setError("We couldn’t complete your answer. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-docslurp-surface="chat" style={surfaceStyle}>
      <style>{embedStyles}</style>
      <textarea
        aria-label="Ask about your documents"
        onChange={(event) => setQ(event.target.value)}
        placeholder={placeholder}
        style={textareaStyle}
        value={q}
      />
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          disabled={busy || !q.trim() || !workspace}
          onClick={() => void send()}
          style={buttonStyle}
          type="button"
        >
          {busy ? "Thinking..." : "Ask"}
        </button>
      </div>
      {error ? (
        <div
          role="alert"
          style={{ ...statusStyle, color: "var(--docslurp-error, #fca5a5)" }}
        >
          {error}
        </div>
      ) : null}
      {answer ? (
        <div role="status" style={{ ...cardStyle, whiteSpace: "pre-wrap" }}>
          {answer}
        </div>
      ) : null}
    </div>
  );
}

export function ViewerEmbed({
  apiUrl = DEFAULT_API_URL,
  documentId,
  clientKey,
}: BaseEmbedProps & {
  documentId: string;
}) {
  const [payload, setPayload] = useState<DocumentViewerPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(
          `${apiUrl.replace(/\/$/, "")}/v1/documents/${encodeURIComponent(documentId)}`,
          {
            headers: buildHeaders(clientKey),
          },
        );
        if (!res.ok) throw new Error("Request failed");
        const json = (await res.json()) as DocumentViewerPayload;
        if (!cancelled) setPayload(json);
      } catch (err) {
        if (!cancelled)
          setError("We couldn’t open this document. Please try again.");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [clientKey, apiUrl, documentId]);

  const primaryArtifact =
    payload?.artifacts.find(
      (artifact) =>
        artifact.slot.includes("markdown") ||
        artifact.slot.includes("canonical"),
    ) ?? payload?.artifacts[0];

  return (
    <div data-docslurp-surface="viewer" style={surfaceStyle}>
      <style>{embedStyles}</style>
      {error ? (
        <div
          role="alert"
          style={{ ...statusStyle, color: "var(--docslurp-error, #fca5a5)" }}
        >
          {error}
        </div>
      ) : null}
      {payload ? (
        <>
          <div style={cardStyle}>
            <div style={metaStyle}>{payload.document.filename}</div>
            <div style={statusStyle}>
              {payload.pageStats.pageCount} pages ·{" "}
              {payload.pageStats.chunkCount} chunks
            </div>
          </div>
          {primaryArtifact ? (
            <iframe
              src={primaryArtifact.url}
              style={iframeStyle}
              title={payload.document.filename}
            />
          ) : (
            <div style={statusStyle}>
              No viewer artifact available for this document yet.
            </div>
          )}
        </>
      ) : !error ? (
        <div role="status" style={statusStyle}>
          Loading document...
        </div>
      ) : null}
    </div>
  );
}

type WebComponentOptions = {
  tagName?: string;
};

function defineReactElement(
  tagName: string,
  render: (element: HTMLElement) => React.ReactNode,
) {
  if (typeof customElements === "undefined" || customElements.get(tagName)) {
    return;
  }

  class DocSlurpElement extends HTMLElement {
    private root: Root | null = null;

    connectedCallback() {
      if (!this.root) {
        this.root = createRoot(this);
      }
      this.root.render(render(this));
    }

    disconnectedCallback() {
      this.root?.unmount();
      this.root = null;
    }
  }

  customElements.define(tagName, DocSlurpElement);
}

export function defineDocSlurpElements(options?: {
  search?: WebComponentOptions;
  chat?: WebComponentOptions;
  viewer?: WebComponentOptions;
}) {
  defineReactElement(
    options?.search?.tagName ?? "docslurp-search",
    (element) => (
      <SearchEmbed
        clientKey={element.getAttribute("client-key") ?? undefined}
        apiUrl={element.getAttribute("api-url") || undefined}
        offline={
          element.getAttribute("offline-bundle-url")
            ? {
                bundleUrl:
                  element.getAttribute("offline-bundle-url") ?? undefined,
                lancedbPath:
                  element.getAttribute("offline-lancedb-path") ?? undefined,
                lancedbTableName:
                  element.getAttribute("offline-lancedb-table") ?? undefined,
                embedding: {
                  model: element.getAttribute("offline-model") ?? undefined,
                  modelBaseUrl:
                    element.getAttribute("offline-model-base-url") ?? undefined,
                },
              }
            : undefined
        }
        workspace={element.getAttribute("workspace") || undefined}
      />
    ),
  );
  defineReactElement(options?.chat?.tagName ?? "docslurp-chat", (element) => (
    <ChatEmbed
      clientKey={element.getAttribute("client-key") ?? undefined}
      apiUrl={element.getAttribute("api-url") || undefined}
      workspace={element.getAttribute("workspace") || undefined}
    />
  ));
  defineReactElement(
    options?.viewer?.tagName ?? "docslurp-viewer",
    (element) => (
      <ViewerEmbed
        clientKey={element.getAttribute("client-key") ?? undefined}
        apiUrl={element.getAttribute("api-url") || undefined}
        documentId={element.getAttribute("document-id") ?? ""}
      />
    ),
  );
}

export {
  createOfflineSearchBundle,
  createOfflineSearchClient,
} from "./offline-search.js";

export type {
  OfflineEmbeddingConfig,
  OfflineSearchBundle,
  OfflineSearchClient,
  OfflineSearchClientOptions,
  OfflineSearchRecord,
  OfflineSearchSourceRecord,
  SearchResult,
} from "./offline-search.js";

// CSS variables let hosts adapt the widgets without rebuilding or changing their API.
const embedStyles = `
[data-docslurp-surface] { box-sizing: border-box; }
[data-docslurp-surface] *, [data-docslurp-surface] *::before, [data-docslurp-surface] *::after { box-sizing: border-box; }
[data-docslurp-surface] input, [data-docslurp-surface] textarea, [data-docslurp-surface] button { font: inherit; }
[data-docslurp-surface] input::placeholder, [data-docslurp-surface] textarea::placeholder { color: var(--docslurp-muted, #8290a4); }
[data-docslurp-surface] input:focus-visible, [data-docslurp-surface] textarea:focus-visible, [data-docslurp-surface] button:focus-visible { outline: 2px solid var(--docslurp-accent, #99f6e4); outline-offset: 3px; }
[data-docslurp-surface] button:not(:disabled):hover { filter: brightness(1.08); }
[data-docslurp-surface] button:not(:disabled):active { transform: translateY(1px); }
[data-docslurp-surface] button:disabled { opacity: .45; cursor: not-allowed; }
[data-docslurp-waiting] { position: relative; height: 28px; overflow: hidden; border-radius: 6px; background: var(--docslurp-input, #0b1220); }
[data-docslurp-waiting] span { position: absolute; top: -28px; width: 1px; height: 24px; background: linear-gradient(transparent, var(--docslurp-accent, #99f6e4), transparent); animation: docslurp-falling-ray 1.8s linear infinite; opacity: .45; }
[data-docslurp-waiting] span:nth-child(1) { left: 24%; }
[data-docslurp-waiting] span:nth-child(2) { left: 55%; animation-delay: -.6s; }
[data-docslurp-waiting] span:nth-child(3) { left: 79%; animation-delay: -1.2s; }
@keyframes docslurp-falling-ray { to { transform: translateY(58px); } }
@media (prefers-reduced-motion: reduce) { [data-docslurp-waiting] span { animation: none; top: 2px; } [data-docslurp-surface] button { transition: none !important; } }
`;
function SearchWaiting() {
  return (
    <div data-docslurp-waiting aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}
const surfaceStyle: React.CSSProperties = {
  display: "grid",
  gap: "0.875rem",
  padding: "1.25rem",
  borderRadius: "0.75rem",
  border: "1px solid var(--docslurp-border, rgba(255,255,255,.1))",
  background: "var(--docslurp-background, #070c15)",
  color: "var(--docslurp-text, #e2e8f0)",
  colorScheme: "dark",
  fontFamily: "inherit",
  fontSize: "0.875rem",
  lineHeight: 1.6,
};
const stackStyle: React.CSSProperties = { display: "grid", gap: "0.5rem" };
const inputStyle: React.CSSProperties = {
  width: "100%",
  minWidth: 0,
  minHeight: "2.75rem",
  borderRadius: "0.5rem",
  border: "1px solid var(--docslurp-border, rgba(255,255,255,.12))",
  background: "var(--docslurp-input, #0b1220)",
  color: "var(--docslurp-text, #e2e8f0)",
  padding: "0.7rem 0.875rem",
  fontSize: "0.875rem",
  transition: "border-color 160ms ease",
};
const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  minHeight: "6rem",
  resize: "vertical",
};
const buttonStyle: React.CSSProperties = {
  justifySelf: "start",
  minHeight: "2.75rem",
  borderRadius: "0.5rem",
  border: "1px solid transparent",
  background: "var(--docslurp-accent, #99f6e4)",
  color: "var(--docslurp-accent-text, #051511)",
  padding: "0.625rem 1rem",
  fontSize: "0.875rem",
  fontWeight: 600,
  cursor: "pointer",
  transition: "filter 160ms ease, transform 160ms ease",
};
const cardStyle: React.CSSProperties = {
  borderRadius: "0.5rem",
  border: "1px solid var(--docslurp-border, rgba(255,255,255,.07))",
  background: "var(--docslurp-panel, rgba(255,255,255,.025))",
  padding: "0.875rem 1rem",
};
const bodyStyle: React.CSSProperties = {
  fontSize: "0.875rem",
  lineHeight: 1.7,
};
const metaStyle: React.CSSProperties = {
  marginTop: "0.5rem",
  fontSize: "0.75rem",
  color: "var(--docslurp-muted, #8290a4)",
};
const statusStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--docslurp-muted, #8290a4)",
};
const iframeStyle: React.CSSProperties = {
  width: "100%",
  minHeight: "28rem",
  border: "1px solid var(--docslurp-border, rgba(255,255,255,.1))",
  borderRadius: "0.5rem",
  background: "var(--docslurp-input, #0b1220)",
};

export default {
  SearchEmbed,
  ChatEmbed,
  ViewerEmbed,
  defineDocSlurpElements,
};
