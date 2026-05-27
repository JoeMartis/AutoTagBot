const fileInput = document.getElementById("files");
const fileList = document.getElementById("file-list");
const form = document.getElementById("batch-form");
const submitBtn = document.getElementById("submit-btn");
const statusEl = document.getElementById("status");
const patternInput = document.getElementById("pattern");

let selectedFiles = [];

function basename(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

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
      const i = Number(e.target.dataset.i);
      selectedFiles[i].customName = e.target.value;
    });
  });
  fileList.querySelectorAll("button.remove").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const i = Number(e.target.dataset.i);
      selectedFiles.splice(i, 1);
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

function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = kind || "";
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (selectedFiles.length === 0) {
    setStatus("Add at least one PDF.", "err");
    return;
  }

  const fd = new FormData();
  const clientId = form.elements.clientId.value.trim();
  const clientSecret = form.elements.clientSecret.value.trim();
  fd.append("clientId", clientId);
  fd.append("clientSecret", clientSecret);
  fd.append("namePattern", patternInput.value || "{name}-tagged");
  fd.append("runAccessibilityChecker", form.elements.runAccessibilityChecker.checked);
  fd.append("generateReport", form.elements.generateReport.checked);
  fd.append("shiftHeadings", form.elements.shiftHeadings.checked);
  if (form.elements.pageStart.value) fd.append("pageStart", form.elements.pageStart.value);
  if (form.elements.pageEnd.value) fd.append("pageEnd", form.elements.pageEnd.value);

  const outputNames = selectedFiles.map((f) => f.customName || "");
  fd.append("outputNames", JSON.stringify(outputNames));

  for (const f of selectedFiles) {
    fd.append("files", f.file, f.file.name);
  }

  submitBtn.disabled = true;
  setStatus(`Processing ${selectedFiles.length} file(s)… this can take a minute per PDF.`);

  try {
    const res = await fetch("/api/batch", { method: "POST", body: fd });
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
    setStatus("Done. Zip downloaded.", "ok");
  } catch (err) {
    setStatus("Failed: " + err.message, "err");
  } finally {
    // Wipe credential fields from memory once the request is done.
    form.elements.clientId.value = "";
    form.elements.clientSecret.value = "";
    submitBtn.disabled = false;
  }
});
