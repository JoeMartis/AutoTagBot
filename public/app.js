const fileInput = document.getElementById("files");
const fileList = document.getElementById("file-list");
const form = document.getElementById("batch-form");
const submitBtn = document.getElementById("submit-btn");
const statusEl = document.getElementById("status");
const patternInput = document.getElementById("pattern");

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

fileInput.addEventListener("change", (e) => {
  const newOnes = Array.from(e.target.files).map((file) => ({ file, customName: "" }));
  selectedFiles = selectedFiles.concat(newOnes);
  fileInput.value = "";
  renderFileList();
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

  const fd = new FormData();
  fd.append("clientId", form.elements.clientId.value.trim());
  fd.append("clientSecret", form.elements.clientSecret.value.trim());
  fd.append("anthropicKey", form.elements.anthropicKey.value.trim());
  fd.append("namePattern", patternInput.value || "{name}-tagged");
  fd.append("runAccessibilityChecker", form.elements.runAccessibilityChecker.checked);
  fd.append("generateReport", form.elements.generateReport.checked);
  fd.append("shiftHeadings", form.elements.shiftHeadings.checked);
  if (form.elements.pageStart.value) fd.append("pageStart", form.elements.pageStart.value);
  if (form.elements.pageEnd.value) fd.append("pageEnd", form.elements.pageEnd.value);
  fd.append("outputNames", JSON.stringify(selectedFiles.map((f) => f.customName || "")));
  for (const f of selectedFiles) fd.append("files", f.file, f.file.name);

  submitBtn.disabled = true;
  setStatus(statusEl, `Tagging ${selectedFiles.length} PDF(s) and drafting alt text — this typically runs ~30–60s per file.`);

  try {
    const res = await fetch("/api/analyze", { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
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
  reviewSummary.textContent = `${session.files.length} PDF(s), ${totalFigs} figure(s). Edit drafts below; blank alt text is allowed for decorative images.`;

  for (const file of session.files) {
    const card = document.createElement("section");
    card.className = "card review-card";
    const fileHeader = document.createElement("div");
    fileHeader.className = "file-header";
    fileHeader.innerHTML = `
      <h3>${file.originalName} <span class="muted">&rarr; ${file.outputBase}.pdf</span></h3>
      <div class="muted small">${file.figures.length} figure(s)</div>
    `;
    card.appendChild(fileHeader);

    if (file.figures.length === 0) {
      const none = document.createElement("p");
      none.className = "muted";
      none.textContent = "No figures detected in this PDF.";
      card.appendChild(none);
    } else {
      const grid = document.createElement("div");
      grid.className = "figure-grid";
      for (const fig of file.figures) {
        const initial = detectFlag(fig.draftAlt);
        const row = document.createElement("div");
        row.className = "figure-row";
        row.dataset.id = fig.id;
        row.innerHTML = `
          <div class="figure-thumb">
            <img src="${fig.thumbnail}" alt="" />
            <div class="figure-meta">p.${fig.page ?? "?"}</div>
          </div>
          <div class="figure-edit">
            <textarea class="alt-input" rows="3" placeholder="Alt text">${escapeHTML(initial.alt)}</textarea>
            <div class="flag-row">
              <label class="check small"><input type="checkbox" class="dec" ${initial.decorative ? "checked" : ""}/> Decorative (no alt)</label>
              <label class="check small"><input type="checkbox" class="cpx" ${initial.complex ? "checked" : ""}/> Complex (needs long description)</label>
              <span class="figure-path muted small">${escapeHTML(fig.path)}</span>
            </div>
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
