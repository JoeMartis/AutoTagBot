const fileInput = document.getElementById("files");
const fileList = document.getElementById("file-list");
const form = document.getElementById("batch-form");
const submitBtn = document.getElementById("submit-btn");
const statusEl = document.getElementById("status");
const patternInput = document.getElementById("pattern");
const draftAltToggle = document.getElementById("draft-alt-toggle");
const anthropicKeyLabel = document.getElementById("anthropic-key-label");
const anthropicKeyInput = anthropicKeyLabel.querySelector("input");

function syncDraftAlt() {
  const on = draftAltToggle.checked;
  anthropicKeyLabel.hidden = !on;
  anthropicKeyInput.required = on;
  anthropicKeyInput.setAttribute("aria-required", on ? "true" : "false");
  if (!on) anthropicKeyInput.value = "";
  submitBtn.textContent = on ? "Analyze & draft alt text" : "Analyze (no drafts)";
}
draftAltToggle.addEventListener("change", syncDraftAlt);
syncDraftAlt();

const stepSubmit = document.getElementById("step-submit");
const stepReview = document.getElementById("step-review");
const reviewList = document.getElementById("review-list");
const reviewSummary = document.getElementById("review-summary");
const finalizeBtn = document.getElementById("finalize-btn");
const backBtn = document.getElementById("back-btn");
const reviewStatus = document.getElementById("review-status");

let selectedFiles = [];
let session = null; // { sessionId, files: [{ originalName, outputBase, figures: [...] }] }

function renderFileList() {
  fileList.innerHTML = "";
  if (selectedFiles.length === 0) return;

  const table = document.createElement("table");
  table.innerHTML = `
    <thead>
      <tr><th>Input</th><th>Size</th><th>Output name (without .pdf)</th><th></th></tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector("tbody");

  selectedFiles.forEach((f, i) => {
    const tr = document.createElement("tr");
    const sizeKb = (f.file.size / 1024).toFixed(0);
    tr.innerHTML = `
      <td class="truncate">${f.file.name}</td>
      <td class="num">${sizeKb} KB</td>
      <td><input type="text" data-i="${i}" class="rename" placeholder="(use pattern)" value="${f.customName || ""}" /></td>
      <td><button type="button" class="remove" data-i="${i}" aria-label="Remove">&times;</button></td>
    `;
    tbody.appendChild(tr);
  });
  fileList.appendChild(table);

  fileList.querySelectorAll("input.rename").forEach((inp) => {
    inp.addEventListener("input", (e) => {
      selectedFiles[Number(e.target.dataset.i)].customName = e.target.value;
    });
  });
  fileList.querySelectorAll("button.remove").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      selectedFiles.splice(Number(e.target.dataset.i), 1);
      renderFileList();
    });
  });
}

function addFiles(fileList) {
  const incoming = Array.from(fileList).filter(
    (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name),
  );
  if (incoming.length === 0) return;
  selectedFiles = selectedFiles.concat(incoming.map((file) => ({ file, customName: "" })));
  renderFileList();
}

fileInput.addEventListener("change", (e) => {
  addFiles(e.target.files);
  fileInput.value = "";
});

// Drag-and-drop on the entire .filedrop label, plus a window-level
// preventDefault so the browser doesn't navigate away if the user
// misses the drop zone.
const dropZone = document.querySelector(".filedrop");
["dragenter", "dragover"].forEach((evt) => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add("dragover");
  });
});
["dragleave", "dragend"].forEach((evt) => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (evt === "dragleave" && dropZone.contains(e.relatedTarget)) return;
    dropZone.classList.remove("dragover");
  });
});
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropZone.classList.remove("dragover");
  if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
});
// Swallow stray drops on the rest of the page so the browser doesn't open the PDF.
["dragover", "drop"].forEach((evt) => {
  window.addEventListener(evt, (e) => {
    if (!dropZone.contains(e.target)) e.preventDefault();
  });
});

function setStatus(el, msg, kind) {
  el.textContent = msg;
  el.className = kind || "";
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (selectedFiles.length === 0) {
    setStatus(statusEl, "Add at least one PDF.", "err");
    return;
  }

  const clientId = form.elements.clientId.value.trim();
  const clientSecret = form.elements.clientSecret.value.trim();
  const draftAlt = draftAltToggle.checked;
  const anthropicKey = draftAlt ? form.elements.anthropicKey.value.trim() : "";

  if (!clientId || !clientSecret) {
    setStatus(statusEl, "Adobe credentials are required.", "err");
    return;
  }
  if (draftAlt && !anthropicKey) {
    setStatus(statusEl, "Anthropic API key is required when 'Draft alt text with Claude' is on.", "err");
    return;
  }

  const fd = new FormData();
  fd.append("clientId", clientId);
  fd.append("clientSecret", clientSecret);
  fd.append("anthropicKey", anthropicKey);
  fd.append("draftAlt", draftAlt);
  fd.append("namePattern", patternInput.value || "{name}-tagged");
  fd.append("runAccessibilityChecker", form.elements.runAccessibilityChecker.checked);
  fd.append("generateReport", form.elements.generateReport.checked);
  fd.append("shiftHeadings", form.elements.shiftHeadings.checked);
  if (form.elements.pageStart.value) fd.append("pageStart", form.elements.pageStart.value);
  if (form.elements.pageEnd.value) fd.append("pageEnd", form.elements.pageEnd.value);
  fd.append("outputNames", JSON.stringify(selectedFiles.map((f) => f.customName || "")));
  for (const f of selectedFiles) fd.append("files", f.file, f.file.name);

  submitBtn.disabled = true;
  submitBtn.setAttribute("aria-busy", "true");
  const baseMsg = draftAlt
    ? `Tagging ${selectedFiles.length} PDF(s) and drafting alt text — this typically runs ~30–60s per file.`
    : `Tagging ${selectedFiles.length} PDF(s) — this typically runs ~15–30s per file.`;
  setStatus(statusEl, baseMsg);

  try {
    const res = await fetch("/api/analyze", { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data.error || `HTTP ${res.status}`;
      const errList = (data.errors || []).map((e) => `${e.file}${e.stage ? ` [${e.stage}]` : ""}: ${e.message}`).join("\n");
      throw new Error(errList ? `${detail}\n${errList}` : detail);
    }
    session = data;
    showReview();
  } catch (err) {
    setStatus(statusEl, "Failed: " + err.message, "err");
  } finally {
    // Wipe credential fields whether or not the call succeeded.
    form.elements.clientId.value = "";
    form.elements.clientSecret.value = "";
    form.elements.anthropicKey.value = "";
    submitBtn.disabled = false;
    submitBtn.removeAttribute("aria-busy");
  }
});

function detectFlag(draft) {
  if (!draft) return { decorative: false, complex: false, alt: "" };
  const trimmed = draft.trim();
  if (/^DECORATIVE\b/i.test(trimmed)) return { decorative: true, complex: false, alt: "" };
  const complexMatch = trimmed.match(/^COMPLEX:\s*(.*)$/is);
  if (complexMatch) return { decorative: false, complex: true, alt: complexMatch[1].trim() };
  return { decorative: false, complex: false, alt: trimmed };
}

function showReview() {
  stepSubmit.hidden = true;
  stepReview.hidden = false;
  reviewList.innerHTML = "";

  const totalFigs = session.files.reduce((n, f) => n + f.figures.length, 0);
  reviewSummary.textContent = `${session.files.length} PDF(s), ${totalFigs} figure(s). Edit alt text below; mark images as decorative to leave alt blank.`;

  // Surface analyze-stage errors (files that failed entirely)
  if (session.errors && session.errors.length) {
    const banner = document.createElement("div");
    banner.className = "warning-banner";
    banner.setAttribute("role", "alert");
    banner.innerHTML = `<strong>${session.errors.length} file(s) failed during analysis</strong><ul>` +
      session.errors.map((e) => `<li>${escapeHTML(e.file)} ${e.stage ? `[${escapeHTML(e.stage)}]` : ""}: ${escapeHTML(e.message)}</li>`).join("") +
      `</ul>`;
    reviewList.appendChild(banner);
  }

  for (const file of session.files) {
    const card = document.createElement("section");
    card.className = "card review-card";
    const fileHeader = document.createElement("div");
    fileHeader.className = "file-header";
    fileHeader.innerHTML = `
      <h3>${escapeHTML(file.originalName)} <span class="muted">&rarr; ${escapeHTML(file.outputBase)}.pdf</span></h3>
      <div class="muted small">${file.figures.length} figure(s)</div>
    `;
    card.appendChild(fileHeader);

    if (file.warnings && file.warnings.length) {
      const w = document.createElement("div");
      w.className = "warning-banner";
      w.innerHTML = `<strong>Partial success:</strong><ul>` +
        file.warnings.map((x) => `<li>${escapeHTML(x.stage)}: ${escapeHTML(x.message)}</li>`).join("") +
        `</ul>`;
      card.appendChild(w);
    }

    if (file.figures.length === 0) {
      const none = document.createElement("p");
      none.className = "muted";
      none.textContent = "No figures detected in this PDF.";
      card.appendChild(none);
    } else {
      const grid = document.createElement("div");
      grid.className = "figure-grid";
      for (const fig of file.figures) {
        const existing = (fig.existingAlt || "").trim();
        const draftParsed = detectFlag(fig.draftAlt);
        // Initial textarea value: prefer existing alt; otherwise use Claude's draft.
        // Flags (decorative/complex) come from the Claude draft only if there's no existing alt.
        const useExisting = existing.length > 0;
        const initialAlt = useExisting ? existing : draftParsed.alt;
        const initialDecorative = !useExisting && draftParsed.decorative;
        const initialComplex = !useExisting && draftParsed.complex;
        // Show Claude's suggestion only if it's meaningfully different from existing.
        const claudeText = draftParsed.alt || (draftParsed.decorative ? "(decorative)" : "");
        const showSuggestion = useExisting && claudeText && claudeText.trim() !== existing;

        const row = document.createElement("div");
        row.className = "figure-row";
        row.dataset.id = fig.id;
        row.innerHTML = `
          <div class="figure-thumb">
            <img src="${fig.thumbnail}" alt="" />
            <div class="figure-meta">p.${fig.page ?? "?"}</div>
          </div>
          <div class="figure-edit">
            ${useExisting ? `<div class="source-tag muted small">Existing alt from PDF</div>` : ""}
            <textarea class="alt-input" rows="3" placeholder="Alt text" aria-label="Alt text for figure on page ${fig.page ?? "?"}">${escapeHTML(initialAlt)}</textarea>
            <div class="flag-row">
              <label class="check small"><input type="checkbox" class="dec" ${initialDecorative ? "checked" : ""}/> Decorative (no alt)</label>
              <label class="check small"><input type="checkbox" class="cpx" ${initialComplex ? "checked" : ""}/> Complex (needs long description)</label>
              <span class="figure-path muted small">${escapeHTML(fig.path)}</span>
            </div>
            ${showSuggestion ? `
              <div class="suggestion">
                <div class="suggestion-label">Claude suggests:</div>
                <div class="suggestion-text">${escapeHTML(claudeText)}</div>
                <button type="button" class="link-btn use-suggestion">Use this</button>
              </div>
            ` : ""}
          </div>
        `;
        // disable textarea when decorative
        const ta = row.querySelector(".alt-input");
        const dec = row.querySelector(".dec");
        const cpx = row.querySelector(".cpx");
        const syncDec = () => {
          ta.disabled = dec.checked;
          if (dec.checked) cpx.checked = false;
        };
        dec.addEventListener("change", syncDec);
        syncDec();

        const useBtn = row.querySelector(".use-suggestion");
        if (useBtn) {
          useBtn.addEventListener("click", () => {
            if (draftParsed.decorative) {
              dec.checked = true;
              cpx.checked = false;
              syncDec();
            } else {
              dec.checked = false;
              cpx.checked = draftParsed.complex;
              syncDec();
              ta.value = draftParsed.alt;
            }
            ta.focus();
          });
        }
        grid.appendChild(row);
      }
      card.appendChild(grid);
    }
    reviewList.appendChild(card);
  }
}

function escapeHTML(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function collectAltText() {
  const out = {};
  reviewList.querySelectorAll(".figure-row").forEach((row) => {
    const id = row.dataset.id;
    const dec = row.querySelector(".dec").checked;
    const cpx = row.querySelector(".cpx").checked;
    const alt = row.querySelector(".alt-input").value.trim();
    out[id] = { alt: dec ? "" : alt, decorative: dec, complex: cpx };
  });
  return out;
}

finalizeBtn.addEventListener("click", async () => {
  finalizeBtn.disabled = true;
  setStatus(reviewStatus, "Applying alt text and re-running the accessibility checker — this can take ~10–30s per PDF…");
  try {
    const res = await fetch("/api/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: session.sessionId, altText: collectAltText() }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "autotagbot-batch.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus(reviewStatus, "Done. Zip downloaded.", "ok");
    session = null;
    // Reset back to step 1 after a short pause.
    setTimeout(() => {
      stepReview.hidden = true;
      stepSubmit.hidden = false;
      selectedFiles = [];
      renderFileList();
      setStatus(statusEl, "");
      setStatus(reviewStatus, "");
    }, 1500);
  } catch (err) {
    setStatus(reviewStatus, "Failed: " + err.message, "err");
  } finally {
    finalizeBtn.disabled = false;
  }
});

backBtn.addEventListener("click", async () => {
  if (!session) return;
  try {
    await fetch("/api/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: session.sessionId }),
    });
  } catch {}
  session = null;
  stepReview.hidden = true;
  stepSubmit.hidden = false;
  setStatus(reviewStatus, "");
});
