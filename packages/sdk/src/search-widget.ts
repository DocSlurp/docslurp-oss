/**
 * Framework-free search widget. Calling this function in SSR is a safe no-op.
 * Attributes: client-key (required unless search-endpoint proxies), optional
 * workspace-id (UUID, slug or "default"; default "default", the key
 * organization's default workspace), api-url (default https://docslurp.io),
 * search-endpoint, placeholder. Server keys (dslp_priv_…) are refused: use a
 * search-only client key (dslp_pub_…) or a search-endpoint proxy.
 */
export function defineDocSlurpSearch() {
  if (typeof window === "undefined" || customElements.get("docslurp-search-box")) return;
  customElements.define("docslurp-search-box", class extends HTMLElement {
    private request: AbortController | null = null;
    private events: AbortController | null = null;
    private timer?: ReturnType<typeof setTimeout>;
    connectedCallback() {
      if (this.events) return;
      const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
      root.innerHTML = `<style>
        :host{display:block;color:var(--docslurp-text,#e2e8f0);font:14px/1.7 system-ui,sans-serif}*{box-sizing:border-box}
        form{display:flex;gap:8px}input{min-width:0;flex:1}input,button{font:inherit;padding:10px 14px;border:1px solid #334155;border-radius:10px;background:var(--docslurp-background,#0b1220);color:inherit}
        button{cursor:pointer;color:#99f6e4}input:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid #5eead4;outline-offset:2px}
        [role=status]{font-size:12px;color:#94a3b8;margin:12px 0}article{padding:16px;border:1px solid #334155;border-radius:12px;margin-top:10px;background:var(--docslurp-background,#0b1220)}p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}footer{margin-top:12px;font-size:12px;color:#94a3b8}a{color:#99f6e4}
        .rays{position:relative;height:24px;overflow:hidden}.rays i{position:absolute;top:0;width:1px;height:12px;background:#5eead4;animation:fall 1s infinite}.rays i:nth-child(1){left:20%}.rays i:nth-child(2){left:50%;animation-delay:-.3s}.rays i:nth-child(3){left:80%;animation-delay:-.6s}@keyframes fall{from{transform:translateY(-12px)}to{transform:translateY(24px)}}@media(prefers-reduced-motion:reduce){.rays i{animation:none}}
      </style><form><input aria-label="Search documents" type="search" maxlength="500" placeholder="Search documents…"><button type="submit">Search</button></form><div role="status" aria-live="polite"></div><div class="rays" hidden aria-hidden="true"><i></i><i></i><i></i></div><div class="results" aria-busy="false"></div>`;
      const input = root.querySelector("input")!;
      input.placeholder = this.getAttribute("placeholder") ?? "Search documents…";
      const status = root.querySelector<HTMLElement>("[role=status]")!;
      const results = root.querySelector<HTMLElement>(".results")!;
      const rays = root.querySelector<HTMLElement>(".rays")!;
      this.events = new AbortController();
      const run = async () => {
        clearTimeout(this.timer); this.request?.abort(); results.replaceChildren();
        const q = input.value.trim();
        if (!q) { status.textContent = ""; rays.hidden = true; results.setAttribute("aria-busy", "false"); return; }
        const request = new AbortController(); this.request = request;
        status.textContent = "Searching…"; rays.hidden = false; results.setAttribute("aria-busy", "true");
        try {
          const proxy = this.getAttribute("search-endpoint");
          const apiUrl = this.getAttribute("api-url")?.trim() || "https://docslurp.io";
          const key = this.getAttribute("client-key");
          const workspaceId = this.getAttribute("workspace-id")?.trim() || "default";
          if (!proxy && !key) throw new Error("Missing search configuration");
          // Inline (not imported from ./keys) so the widget stays one self-contained file for WordPress.
          if (!proxy && key?.startsWith("dslp_priv_")) {
            console.error("docslurp-search-box: refusing to send a server key (dslp_priv_…) from the browser. Use a search-only client key (dslp_pub_…) or a search-endpoint proxy.");
            status.textContent = "Search is misconfigured.";
            return;
          }
          const response = await fetch(proxy ?? `${apiUrl.replace(/\/$/, "")}/v1/search`, { method: "POST", credentials: "omit", signal: request.signal, headers: { "Content-Type": "application/json", ...(!proxy && key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(proxy ? { q } : { q, workspaceId, limit: 6 }) });
          if (!response.ok) throw new Error("Search unavailable");
          const body = await response.json();
          if (request.signal.aborted || this.request !== request) return;
          for (const hit of body.results ?? []) {
            const article = document.createElement("article"), text = document.createElement("p"), footer = document.createElement("footer");
            text.textContent = hit.text;
            const citation = hit.citation ?? {};
            const source = hit.url ?? citation.canonicalDocumentUri;
            if (typeof source === "string" && (/^https?:\/\//.test(source) || /^\/(?!\/)/.test(source))) {
              const link = document.createElement("a"); link.href = source; link.textContent = citation.filename ?? "View source"; footer.append(link);
            } else footer.textContent = citation.filename ?? "Source document";
            if (citation.pageNumbers?.length) footer.append(` · pages ${citation.pageNumbers.join(", ")}`);
            article.append(text, footer); results.append(article);
          }
          status.textContent = results.childElementCount ? `Found ${results.childElementCount} results` : "No matching passages.";
        } catch { if (!request.signal.aborted) status.textContent = "Search is unavailable. Please try again."; }
        finally { if (this.request === request) { rays.hidden = true; results.setAttribute("aria-busy", "false"); } }
      };
      root.querySelector("form")!.addEventListener("submit", event => { event.preventDefault(); void run(); }, { signal: this.events.signal });
      input.addEventListener("input", () => { this.request?.abort(); clearTimeout(this.timer); results.replaceChildren(); rays.hidden = true; status.textContent = ""; results.setAttribute("aria-busy", "false"); this.timer = setTimeout(() => void run(), 250); }, { signal: this.events.signal });
    }
    disconnectedCallback() { this.request?.abort(); this.events?.abort(); this.events = null; clearTimeout(this.timer); }
  });
}
