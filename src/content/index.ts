import { ext } from "../shared/browser";
import type { Anchor, Annotation, CaptureKind, ElementAnchor, FreehandAnchor, PageAnnotations, Point, Rect } from "../shared/model";
import { MAX_NOTE_TEXT, MAX_POINTS } from "../shared/pure";

declare global { interface Window { __productPassLoaded?: boolean } }

if (!window.__productPassLoaded) {
  window.__productPassLoaded = true;
  start();
}

function start(): void {
  const host = document.createElement("div");
  host.id = "product-pass-overlay-host";
  Object.assign(host.style, { position: "fixed", inset: "0", zIndex: "2147483647", pointerEvents: "none" });
  document.documentElement.append(host);
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `:host{all:initial}.layer{position:fixed;inset:0;pointer-events:none}.box{position:fixed;border:3px solid #ff633f;background:#ff633f1f;box-sizing:border-box}.candidate{border-color:#ffb020;background:#ffb02022}.annotation-marker{position:fixed;z-index:2;display:flex;align-items:center;max-width:min(260px,70vw);height:26px;padding:0;border:2px solid #fff;border-radius:3px;background:#c74625;color:#fff;box-shadow:0 2px 8px #0007;font:700 12px/1 system-ui;pointer-events:auto;cursor:pointer}.annotation-number{display:grid;place-items:center;flex:0 0 24px;height:22px}.annotation-caption{display:none;min-width:0;padding:0 7px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.annotation-marker:hover .annotation-caption,.annotation-marker:focus-visible .annotation-caption{display:block}.annotation-marker:focus-visible{outline:3px solid #64a8ff;outline-offset:2px}.saved-path{pointer-events:stroke;cursor:pointer}.saved-path:hover,.saved-path:focus{stroke-width:5}.hint{position:fixed;top:12px;left:50%;transform:translateX(-50%);background:#171717;color:white;padding:9px 13px;border-radius:4px;font:14px system-ui;box-shadow:0 2px 8px #0005}.draw{position:fixed;inset:0;width:100%;height:100%;pointer-events:auto;cursor:crosshair;touch-action:none}@media(forced-colors:active){.box{border-color:Highlight;background:transparent}.annotation-marker{border:2px solid ButtonText;background:ButtonFace;color:ButtonText}}`;
  const savedLayer = document.createElement("div"); savedLayer.className = "layer";
  const activeLayer = document.createElement("div"); activeLayer.className = "layer";
  root.append(style, savedLayer, activeLayer);

  let notes: Annotation[] = [];
  let annotationsVisible = true;
  let pageUrl = location.href;
  let cancelCapture: (() => void) | null = null;

  async function rpc<T>(message: unknown): Promise<T> {
    const response = await ext.runtime.sendMessage(message) as { ok: boolean; value?: T; error?: string };
    if (!response?.ok) throw new Error(response?.error || "Product Pass request failed.");
    return response.value as T;
  }

  async function refresh(): Promise<void> {
    try { const page = await rpc<PageAnnotations>({ type: "GET_PAGE", url: location.href }); notes = page.annotations; annotationsVisible = page.visible; renderSaved(); }
    catch { notes = []; annotationsVisible = false; renderSaved(); }
  }

  function renderSaved(): void {
    savedLayer.replaceChildren(); if (!annotationsVisible) return;
    [...notes].sort((a, b) => b.createdAt - a.createdAt).forEach((note, index) => { if (note.anchor.kind === "element") renderElement(note, index); else renderPath(note, index); });
  }

  function box(rect: DOMRect | Rect, className = "box"): HTMLDivElement {
    const item = document.createElement("div"); item.className = className;
    Object.assign(item.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    return item;
  }

  function selectAnnotation(note: Annotation, event: Event): void {
    event.preventDefault(); event.stopPropagation();
    void rpc({ type: "SELECT_ANNOTATION", annotationId: note.id, url: location.href }).catch(() => undefined);
  }
  function marker(note: Annotation, index: number, rect: Rect): HTMLButtonElement {
    const item = document.createElement("button"); item.type = "button"; item.className = "annotation-marker";
    const number = document.createElement("span"); number.className = "annotation-number"; number.textContent = String(index + 1);
    const caption = document.createElement("span"); caption.className = "annotation-caption"; caption.textContent = (note.text || note.contextLabel || note.pageTitle || "Open annotation").slice(0, 100);
    item.setAttribute("aria-label", `Open annotation ${index + 1}: ${caption.textContent}`);
    Object.assign(item.style, { left: `${Math.max(4, Math.min(innerWidth - 30, rect.x))}px`, top: `${Math.max(4, Math.min(innerHeight - 30, rect.y - 29))}px` });
    item.append(number, caption); item.addEventListener("click", event => selectAnnotation(note, event)); return item;
  }

  function renderElement(note: Annotation, index: number): void {
    if (note.anchor.kind !== "element") return; const anchor = note.anchor;
    let selected: Element | null = null;
    try { selected = document.querySelector(anchor.selector); } catch { return; }
    if (!selected) return;
    const rect = selected.getBoundingClientRect();
    if (rect.width && rect.height) savedLayer.append(box(rect), marker(note, index, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }));
  }

  function renderPath(note: Annotation, index: number): void {
    if (note.anchor.kind !== "freehand") return; const anchor = note.anchor;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    Object.assign(svg.style, { position: "fixed", inset: "0", width: "100%", height: "100%", overflow: "visible" });
    const polygon = document.createElementNS(svg.namespaceURI, "polygon"); polygon.classList.add("saved-path"); polygon.setAttribute("tabindex", "0");
    polygon.setAttribute("aria-label", `Open annotation ${index + 1}`); polygon.setAttribute("points", anchor.points.map(point => `${point.x - scrollX},${point.y - scrollY}`).join(" "));
    polygon.setAttribute("fill", "#ff633f1f"); polygon.setAttribute("stroke", "#ff633f"); polygon.setAttribute("stroke-width", "3"); polygon.addEventListener("click", event => selectAnnotation(note, event)); polygon.addEventListener("keydown", event => { const key = (event as KeyboardEvent).key; if (key === "Enter" || key === " ") selectAnnotation(note, event); });
    const bounds = { ...anchor.bounds, x: anchor.bounds.x - scrollX, y: anchor.bounds.y - scrollY };
    svg.append(polygon); savedLayer.append(svg, marker(note, index, bounds));
  }

  function selectorFor(element: Element): string {
    if (element.id) return `#${CSS.escape(element.id)}`;
    for (const attribute of ["data-testid", "data-test", "aria-label"]) {
      const value = element.getAttribute(attribute);
      if (value && value.length <= 100) return `${element.localName}[${attribute}="${CSS.escape(value)}"]`;
    }
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current !== document.documentElement && parts.length < 6) {
      const siblings = current.parentElement ? [...current.parentElement.children].filter(item => item.localName === current!.localName) : [];
      const nth = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : "";
      parts.unshift(`${current.localName}${nth}`); current = current.parentElement;
    }
    return `html > ${parts.join(" > ")}`;
  }

  function contextFor(element: Element): string {
    return (element.getAttribute("aria-label") || element.textContent || element.localName).replace(/\s+/g, " ").trim().slice(0, 160);
  }

  async function save(kind: CaptureKind, anchor: Anchor, contextLabel: string): Promise<void> {
    const entered = window.prompt("Add context for this annotation (optional, up to 2000 characters):", "");
    if (entered === null) return;
    try {
      await rpc({ type: "SAVE_ANNOTATION", annotation: { kind, url: location.href, pageTitle: document.title.slice(0, 300), text: entered.slice(0, MAX_NOTE_TEXT), contextLabel, anchor, viewport: { scrollX, scrollY, width: innerWidth, height: innerHeight } } });
      await refresh();
    } catch (error) { window.alert(error instanceof Error ? error.message : "Could not save annotation."); }
  }

  function stop(): void { cancelCapture?.(); cancelCapture = null; activeLayer.replaceChildren(); }

  function elementCapture(): void {
    stop();
    const hint = document.createElement("div"); hint.className = "hint"; hint.setAttribute("role", "status"); hint.setAttribute("aria-live", "polite"); hint.textContent = "Choose an element • Tab cycles • Enter selects • Esc cancels"; activeLayer.append(hint);
    let current: Element | null = null; let highlight: HTMLElement | null = null; let candidateIndex = -1;
    const candidates = [...document.querySelectorAll("body *")].filter(element => {
      const rect = element.getBoundingClientRect(); return element !== host && rect.width >= 8 && rect.height >= 8 && getComputedStyle(element).visibility !== "hidden";
    }).slice(0, 1_000);
    const show = (element: Element | null) => {
      current = element; highlight?.remove(); highlight = null;
      if (!element || element === host || host.contains(element)) return;
      const rect = element.getBoundingClientRect(); highlight = box(rect, "box candidate"); activeLayer.append(highlight);
      hint.textContent = `Selected ${contextFor(element) || element.localName}. Tab cycles, Enter saves, Escape cancels.`;
    };
    const move = (event: PointerEvent) => show(document.elementFromPoint(event.clientX, event.clientY));
    const choose = (event?: Event) => {
      if (!current) return; event?.preventDefault(); event?.stopPropagation();
      const selected = current; const rect = selected.getBoundingClientRect(); stop();
      const anchor: ElementAnchor = { kind: "element", selector: selectorFor(selected), quote: contextFor(selected), rect: { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height } };
      void save("element", anchor, contextFor(selected));
    };
    const click = (event: MouseEvent) => choose(event);
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); stop(); }
      else if (event.key === "Enter") choose(event);
      else if (event.key === "Tab" && candidates.length) { event.preventDefault(); candidateIndex = (candidateIndex + (event.shiftKey ? -1 : 1) + candidates.length) % candidates.length; show(candidates[candidateIndex]); }
    };
    document.addEventListener("pointermove", move, true); document.addEventListener("click", click, true); document.addEventListener("keydown", key, true);
    cancelCapture = () => { document.removeEventListener("pointermove", move, true); document.removeEventListener("click", click, true); document.removeEventListener("keydown", key, true); activeLayer.replaceChildren(); };
  }

  function freehandCapture(): void {
    stop();
    const canvas = document.createElement("canvas"); canvas.className = "draw"; canvas.width = innerWidth * devicePixelRatio; canvas.height = innerHeight * devicePixelRatio;
    canvas.tabIndex = 0; canvas.setAttribute("role", "application");
    canvas.setAttribute("aria-label", "Boundary capture. Drag with a pointer, or use arrow keys to move the keyboard rectangle, Shift plus arrows to resize it, Enter to save, and Escape to cancel.");
    const context = canvas.getContext("2d")!; context.scale(devicePixelRatio, devicePixelRatio); context.strokeStyle = "#f97316"; context.lineWidth = 3; context.fillStyle = "#f9731633";
    const hint = document.createElement("div"); hint.className = "hint"; hint.setAttribute("role", "status"); hint.setAttribute("aria-live", "polite"); hint.textContent = "Drag around an area, or use arrows / Shift+arrows / Enter with the keyboard • Esc cancels"; activeLayer.append(canvas, hint);
    let points: Point[] = []; let drawing = false; const previousOverflow = document.documentElement.style.overflow;
    const keyboardRect = { x: Math.max(10, innerWidth / 2 - 100), y: Math.max(60, innerHeight / 2 - 75), width: Math.min(200, innerWidth - 20), height: Math.min(150, innerHeight - 70) };
    document.documentElement.style.overflow = "hidden";
    const renderKeyboardRect = () => { context.clearRect(0, 0, innerWidth, innerHeight); context.fillRect(keyboardRect.x, keyboardRect.y, keyboardRect.width, keyboardRect.height); context.strokeRect(keyboardRect.x, keyboardRect.y, keyboardRect.width, keyboardRect.height); };
    const down = (event: PointerEvent) => { drawing = true; points = [{ x: event.clientX + scrollX, y: event.clientY + scrollY }]; canvas.setPointerCapture(event.pointerId); context.clearRect(0, 0, innerWidth, innerHeight); context.beginPath(); context.moveTo(event.clientX, event.clientY); };
    const move = (event: PointerEvent) => { if (!drawing || points.length >= MAX_POINTS) return; const last = points.at(-1)!; const point = { x: event.clientX + scrollX, y: event.clientY + scrollY }; if (Math.hypot(point.x - last.x, point.y - last.y) < 2) return; points.push(point); context.lineTo(event.clientX, event.clientY); context.stroke(); };
    const finish = (captured: Point[]) => {
      const xs = captured.map(point => point.x); const ys = captured.map(point => point.y);
      const bounds = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
      stop();
      if (captured.length < 3 || bounds.width < 10 || bounds.height < 10) { window.alert("Draw a larger boundary and try again."); return; }
      void save("freehand", { kind: "freehand", points: captured, bounds }, "");
    };
    const up = () => { if (!drawing) return; drawing = false; finish(points); };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); stop(); return; }
      if (event.key === "Enter") {
        event.preventDefault(); const { x, y, width, height } = keyboardRect;
        finish([{ x: x + scrollX, y: y + scrollY }, { x: x + width + scrollX, y: y + scrollY }, { x: x + width + scrollX, y: y + height + scrollY }, { x: x + scrollX, y: y + height + scrollY }]); return;
      }
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault(); const amount = event.altKey ? 1 : 10; const horizontal = event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0; const vertical = event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0;
      if (event.shiftKey) { keyboardRect.width = Math.max(20, Math.min(innerWidth - keyboardRect.x, keyboardRect.width + horizontal)); keyboardRect.height = Math.max(20, Math.min(innerHeight - keyboardRect.y, keyboardRect.height + vertical)); }
      else { keyboardRect.x = Math.max(0, Math.min(innerWidth - keyboardRect.width, keyboardRect.x + horizontal)); keyboardRect.y = Math.max(0, Math.min(innerHeight - keyboardRect.height, keyboardRect.y + vertical)); }
      renderKeyboardRect(); hint.textContent = `Keyboard boundary at ${Math.round(keyboardRect.x)}, ${Math.round(keyboardRect.y)}, size ${Math.round(keyboardRect.width)} by ${Math.round(keyboardRect.height)}. Enter saves.`;
    };
    canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerup", up); canvas.addEventListener("keydown", key);
    cancelCapture = () => { document.documentElement.style.overflow = previousOverflow; canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerup", up); canvas.removeEventListener("keydown", key); activeLayer.replaceChildren(); };
    renderKeyboardRect(); canvas.focus();
  }

  ext.runtime.onMessage.addListener((message: { type?: string; mode?: CaptureKind }, _sender, sendResponse) => {
    if (message.type === "REFRESH") { void refresh(); sendResponse({ ok: true }); return false; }
    if (message.type !== "START_CAPTURE") return false;
    if (message.mode === "element") elementCapture(); else if (message.mode === "freehand") freehandCapture();
    sendResponse({ ok: true }); return false;
  });
  addEventListener("scroll", renderSaved, { passive: true }); addEventListener("resize", renderSaved);
  setInterval(() => { if (location.href !== pageUrl) { stop(); pageUrl = location.href; void rpc({ type: "PAGE_CHANGED", url: pageUrl }).finally(refresh); } }, 750);
  void refresh();
}
