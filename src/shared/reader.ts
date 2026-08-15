export function buildReaderModeScript(): string {
  return `(() => {
    const overlayId = "__openstrawberry_reader_overlay";
    const existing = document.getElementById(overlayId);
    if (existing) { existing.remove(); return false; }
    const source = document.querySelector("article, main, [role='main']") || document.body;
    const overlay = document.createElement("section");
    overlay.id = overlayId;
    Object.assign(overlay.style, { position: "fixed", inset: "0", zIndex: "2147483647", overflow: "auto", background: "#0b0c0d", color: "#edf0f2", padding: "48px max(24px, calc((100vw - 760px) / 2))", fontFamily: "ui-serif, Georgia, serif", lineHeight: "1.7", fontSize: "19px" });
    const close = document.createElement("button");
    close.textContent = "Exit reader mode";
    Object.assign(close.style, { position: "fixed", top: "18px", right: "18px", border: "1px solid #626970", borderRadius: "7px", background: "#17191b", color: "#edf0f2", padding: "8px 11px", cursor: "pointer", font: "12px ui-sans-serif, system-ui" });
    close.onclick = () => overlay.remove();
    const title = document.createElement("h1");
    title.textContent = document.title || "Reader mode";
    Object.assign(title.style, { maxWidth: "760px", margin: "0 auto 22px", fontSize: "34px", lineHeight: "1.14", letterSpacing: "-0.025em" });
    overlay.append(close, title);
    const content = document.createElement("div");
    content.style.maxWidth = "760px";
    content.style.margin = "0 auto";
    Array.from(source.querySelectorAll("h1, h2, h3, p, li, pre, blockquote")).slice(0, 500).forEach((element) => {
      const text = (element.textContent || "").replace(/\\s+/g, " ").trim();
      if (text.length < 2) return;
      const block = document.createElement(element.tagName === "PRE" ? "pre" : element.tagName === "BLOCKQUOTE" ? "blockquote" : element.tagName.startsWith("H") ? "h2" : "p");
      block.textContent = text;
      if (block.tagName === "H2") Object.assign(block.style, { margin: "34px 0 9px", fontSize: "24px", lineHeight: "1.25" });
      if (block.tagName === "P") block.style.margin = "0 0 17px";
      if (block.tagName === "BLOCKQUOTE") Object.assign(block.style, { margin: "20px 0", borderLeft: "3px solid #868d92", paddingLeft: "16px", color: "#c7cccf" });
      if (block.tagName === "PRE") Object.assign(block.style, { overflow: "auto", borderRadius: "8px", background: "#141618", padding: "14px", fontSize: "13px", lineHeight: "1.5" });
      content.appendChild(block);
    });
    if (!content.childElementCount) { const empty = document.createElement("p"); empty.textContent = "This page did not expose enough readable text for reader mode."; content.appendChild(empty); }
    overlay.appendChild(content);
    document.documentElement.appendChild(overlay);
    return true;
  })()`;
}
