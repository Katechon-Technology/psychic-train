import type { Page } from "playwright";

export interface SnapshotElement {
  ref: string;
  role: string;
  name?: string;
  value?: string;
  tag: string;
  href?: string;
  placeholder?: string;
  disabled?: boolean;
  checked?: boolean;
}

export interface SnapshotResult {
  url: string;
  title: string;
  elements: SnapshotElement[];
}

/**
 * Walks the page DOM, finds interactive elements, tags each with a
 * `data-ai-ref="eN"` attribute. Subsequent click/type calls resolve refs
 * via `[data-ai-ref="eN"]` selectors.
 *
 * The DOM walker is held as a string and fed through `page.evaluate` to
 * avoid esbuild's name-wrapping (`__name(...)`) which would reference an
 * undefined helper in the browser context.
 */
const SNAPSHOT_JS = `(() => {
  const INTERACTIVE_TAGS = new Set([
    "a", "button", "input", "select", "textarea", "summary",
    "details", "label", "option"
  ]);
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "textbox", "searchbox", "combobox", "checkbox",
    "radio", "switch", "tab", "menuitem", "menuitemcheckbox",
    "menuitemradio", "option", "slider", "spinbutton", "treeitem",
    "row", "cell", "columnheader", "rowheader"
  ]);

  for (const el of Array.from(document.querySelectorAll("[data-ai-ref]"))) {
    el.removeAttribute("data-ai-ref");
  }

  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (INTERACTIVE_TAGS.has(tag)) return true;
    const role = el.getAttribute("role");
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el.hasAttribute("contenteditable") &&
        el.getAttribute("contenteditable") !== "false") return true;
    if (el.hasAttribute("onclick") || el.hasAttribute("tabindex")) return true;
    return false;
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (parseFloat(style.opacity) === 0) return false;
    return true;
  }

  function getRole(el) {
    const r = el.getAttribute("role");
    if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === "a" && el.hasAttribute("href")) return "link";
    if (t === "button") return "button";
    if (t === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button") return "button";
      if (type === "search") return "searchbox";
      return "textbox";
    }
    if (t === "textarea") return "textbox";
    if (t === "select") return "combobox";
    return t;
  }

  function getName(el) {
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const ref = document.getElementById(labelledby);
      if (ref && ref.textContent) return ref.textContent.trim().slice(0, 200);
    }
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim().slice(0, 200);
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      const id = el.getAttribute("id");
      if (id) {
        const lab = document.querySelector('label[for="' + CSS.escape(id) + '"]');
        if (lab && lab.textContent) return lab.textContent.trim().slice(0, 200);
      }
      const ph = el.placeholder;
      if (ph) return ph.slice(0, 200);
    }
    const title = el.getAttribute("title");
    if (title) return title.slice(0, 200);
    const text = el.textContent && el.textContent.trim();
    if (text) return text.replace(/\\s+/g, " ").slice(0, 200);
    return undefined;
  }

  const elements = [];
  let counter = 0;
  const all = document.querySelectorAll("*");
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (!isInteractive(el)) continue;
    if (!isVisible(el)) continue;
    const ref = "e" + (++counter);
    el.setAttribute("data-ai-ref", ref);
    const item = { ref, role: getRole(el), tag: el.tagName.toLowerCase() };
    const name = getName(el);
    if (name) item.name = name;
    if (el.tagName === "A" && el.href) item.href = el.href;
    if ("value" in el && el.value) item.value = String(el.value).slice(0, 200);
    if ("placeholder" in el && el.placeholder && !item.name) item.placeholder = el.placeholder;
    if (el.disabled) item.disabled = true;
    if ("checked" in el) item.checked = !!el.checked;
    elements.push(item);
  }

  return { url: location.href, title: document.title, elements };
})()`;

export class SnapshotIndex {
  constructor(private page: Page) {}

  selectorForRef(ref: string): string {
    if (!/^e\d+$/.test(ref)) throw new Error(`bad ref format: ${ref}`);
    return `[data-ai-ref="${ref}"]`;
  }

  locator(ref: string) {
    return this.page.locator(this.selectorForRef(ref)).first();
  }

  async build(): Promise<SnapshotResult> {
    const data = await this.page.evaluate(SNAPSHOT_JS);
    return data as SnapshotResult;
  }
}
