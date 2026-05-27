const express = require("express");
const multer = require("multer");
const archiver = require("archiver");
const AdmZip = require("adm-zip");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const {
  ServicePrincipalCredentials,
  PDFServices,
  MimeType,
  AutotagPDFJob,
  AutotagPDFParams,
  AutotagPDFResult,
  ExtractPDFJob,
  ExtractPDFParams,
  ExtractPDFResult,
  ExtractElementType,
  ExtractRenditionsElementType,
  PDFAccessibilityCheckerJob,
  PDFAccessibilityCheckerParams,
  PDFAccessibilityCheckerResult,
} = require("@adobe/pdfservices-node-sdk");

const Anthropic = require("@anthropic-ai/sdk").default;

const PORT = process.env.PORT || 3000;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLAUDE_MODEL = "claude-haiku-4-5";
const CLAUDE_CONCURRENCY = 4;
const PYTHON_BIN = process.env.PYTHON_BIN || "python3";
const APPLY_ALT_SCRIPT = path.join(__dirname, "scripts", "apply_alt.py");
const READ_ALT_SCRIPT = path.join(__dirname, "scripts", "read_alt.py");

function runPython(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, [scriptPath, ...args]);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch {}
      if (code === 0) return resolve(parsed || { ok: true });
      const err = new Error(
        (parsed && parsed.error) ||
          stderr.trim() ||
          `${path.basename(scriptPath)} exited with code ${code}`,
      );
      err.code = code;
      err.report = parsed;
      reject(err);
    });
  });
}

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      const dir = path.join(os.tmpdir(), "autotagbot-" + crypto.randomBytes(6).toString("hex"));
      await fsp.mkdir(dir, { recursive: true });
      cb(null, dir);
    },
    // file.originalname is attacker-controlled (multipart Content-Disposition).
    // Never use it for the on-disk path — multer would happily path.join it
    // with the destination, and "../../foo" escapes. Use a random opaque
    // name on disk; the route handler still has file.originalname (unchanged
    // by multer) for display + output-name derivation, which is then run
    // through sanitizeName() before being used in any path.
    filename: (_req, file, cb) => {
      const ext = path.extname(path.basename(file.originalname || ""));
      const safeExt = /^\.[A-Za-z0-9]{1,5}$/.test(ext) ? ext.toLowerCase() : ".pdf";
      cb(null, crypto.randomBytes(8).toString("hex") + safeExt);
    },
  }),
  limits: { fileSize: MAX_FILE_BYTES },
});

// In-memory session store: sessionId -> { createdAt, workDir, options, files: [{outputBase, taggedPath, figures}] }
const sessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) {
      fsp.rm(s.workDir, { recursive: true, force: true }).catch(() => {});
      sessions.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();

function sanitizeName(name, fallback) {
  const cleaned = (name || "").replace(/[\/\\:*?"<>|]/g, "_").trim();
  return cleaned || fallback;
}

function applyPattern(pattern, basename) {
  return pattern.replace(/\{name\}/g, basename).replace(/\{basename\}/g, basename);
}

async function streamToFile(readStream, destPath) {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(destPath);
    readStream.pipe(ws);
    ws.on("finish", resolve);
    ws.on("error", reject);
    readStream.on("error", reject);
  });
}

async function downloadAssetToFile(pdfServices, asset, destPath) {
  const streamAsset = await pdfServices.getContent({ asset });
  await streamToFile(streamAsset.readStream, destPath);
}

async function runAutotag(pdfServices, inputPath, options) {
  const readStream = fs.createReadStream(inputPath);
  const inputAsset = await pdfServices.upload({ readStream, mimeType: MimeType.PDF });
  const params = new AutotagPDFParams({
    shiftHeadings: !!options.shiftHeadings,
    generateReport: !!options.generateReport,
  });
  const job = new AutotagPDFJob({ inputAsset, params });
  const pollingURL = await pdfServices.submit({ job });
  const response = await pdfServices.getJobResult({ pollingURL, resultType: AutotagPDFResult });
  return response.result;
}

async function runExtract(pdfServices, inputPath) {
  const readStream = fs.createReadStream(inputPath);
  const inputAsset = await pdfServices.upload({ readStream, mimeType: MimeType.PDF });
  const params = new ExtractPDFParams({
    elementsToExtract: [ExtractElementType.TEXT],
    elementsToExtractRenditions: [ExtractRenditionsElementType.FIGURES],
  });
  const job = new ExtractPDFJob({ inputAsset, params });
  const pollingURL = await pdfServices.submit({ job });
  const response = await pdfServices.getJobResult({ pollingURL, resultType: ExtractPDFResult });
  return response.result;
}

async function runAccessibilityChecker(pdfServices, inputPath, options) {
  const readStream = fs.createReadStream(inputPath);
  const inputAsset = await pdfServices.upload({ readStream, mimeType: MimeType.PDF });
  const cfg = {};
  if (options.pageStart) cfg.pageStart = options.pageStart;
  if (options.pageEnd) cfg.pageEnd = options.pageEnd;
  const params = new PDFAccessibilityCheckerParams(cfg);
  const job = new PDFAccessibilityCheckerJob({ inputAsset, params });
  const pollingURL = await pdfServices.submit({ job });
  const response = await pdfServices.getJobResult({
    pollingURL,
    resultType: PDFAccessibilityCheckerResult,
  });
  return response.result;
}

async function unzipExtractResult(pdfServices, extractResult, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  const zipPath = path.join(destDir, "extract.zip");
  await downloadAssetToFile(pdfServices, extractResult.resource, zipPath);
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(destDir, true);
  await fsp.unlink(zipPath).catch(() => {});
  const jsonPath = path.join(destDir, "structuredData.json");
  const raw = await fsp.readFile(jsonPath, "utf8");
  return { json: JSON.parse(raw), dir: destDir };
}

function collectFigures(structuredData, extractDir) {
  const figs = [];
  for (const el of structuredData.elements || []) {
    if (!el.Path || !el.Path.includes("Figure")) continue;
    const rendition = (el.filePaths || []).find((p) => /figures\//i.test(p));
    if (!rendition) continue;
    const absPath = path.join(extractDir, rendition);
    if (!fs.existsSync(absPath)) continue;
    figs.push({
      path: el.Path,
      page: typeof el.Page === "number" ? el.Page + 1 : null,
      bbox: el.Bounds || null,
      renditionPath: absPath,
    });
  }
  return figs;
}

async function generateAlt(anthropic, renditionPath) {
  const buf = await fsp.readFile(renditionPath);
  const ext = path.extname(renditionPath).toLowerCase().replace(".", "");
  const mediaType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
  const message = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: buf.toString("base64") },
          },
          {
            type: "text",
            text: [
              "Write concise alt text for this image from a PDF document, suitable for a screen reader.",
              "Rules:",
              "- One to two sentences. Aim for under 125 characters when possible.",
              "- Describe what is shown, not that it is an image.",
              "- If it appears purely decorative, reply with the single word DECORATIVE.",
              "- If it is a chart, table, or diagram with substantial information, summarize the key takeaway and flag it as COMPLEX so a longer description can be added.",
              "Return only the alt text (or DECORATIVE / COMPLEX: ...), no quotes or preamble.",
            ].join("\n"),
          },
        ],
      },
    ],
  });
  const text = message.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
  return text;
}

async function generateAltBatch(anthropic, figures) {
  const results = new Array(figures.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= figures.length) return;
      try {
        results[i] = await withRetry(
          () => generateAlt(anthropic, figures[i].renditionPath),
          { label: `claude figure ${i}`, attempts: 4, baseMs: 1500 },
        );
      } catch (err) {
        // Leave alt empty so the user just sees an empty textarea instead of
        // pasted-in error text. Per-file warning surfaces in the response.
        console.warn(`[claude] figure ${i} failed: ${describeError(err)}`);
        results[i] = "";
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CLAUDE_CONCURRENCY, figures.length) }, worker));
  return results;
}

async function buildThumbnail(renditionPath) {
  // Just inline the rendition. Adobe's figure renditions are already reasonably sized.
  const buf = await fsp.readFile(renditionPath);
  const ext = path.extname(renditionPath).toLowerCase().replace(".", "");
  const mediaType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
  return `data:${mediaType};base64,${buf.toString("base64")}`;
}

function describeError(err) {
  if (!err) return "unknown error";
  // Adobe SDK errors carry useful detail on `.statusCode`/`.response.body`.
  const parts = [];
  if (err.statusCode) parts.push(`HTTP ${err.statusCode}`);
  if (err.message) parts.push(err.message);
  if (err.response && err.response.body) {
    try {
      const body = typeof err.response.body === "string" ? err.response.body : JSON.stringify(err.response.body);
      if (body && !parts.join(" ").includes(body.slice(0, 80))) parts.push(body.slice(0, 300));
    } catch {}
  }
  return parts.join(" — ") || String(err);
}

async function withRetry(fn, { attempts = 3, baseMs = 1000, label = "call" } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.status || err.statusCode;
      const retriable = status === 429 || (status >= 500 && status < 600) || err.code === "ECONNRESET" || err.code === "ETIMEDOUT";
      if (i === attempts - 1 || !retriable) throw err;
      const delay = baseMs * Math.pow(2, i);
      console.warn(`[retry] ${label} failed (${describeError(err)}); retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

app.post("/api/analyze", upload.array("files"), async (req, res) => {
  const clientId = req.body.clientId;
  const clientSecret = req.body.clientSecret;
  const anthropicKey = req.body.anthropicKey;
  const draftAlt = req.body.draftAlt === "true";
  if (!clientId || !clientSecret) return res.status(400).json({ error: "Missing Adobe credentials." });
  if (draftAlt && !anthropicKey) return res.status(400).json({ error: "Anthropic API key required when 'draft alt text' is on." });
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: "No PDF files uploaded." });

  let outputNames = [];
  try {
    outputNames = req.body.outputNames ? JSON.parse(req.body.outputNames) : [];
  } catch {
    return res.status(400).json({ error: "Invalid outputNames JSON." });
  }

  const options = {
    shiftHeadings: req.body.shiftHeadings === "true",
    generateReport: req.body.generateReport === "true",
    runAccessibilityChecker: req.body.runAccessibilityChecker === "true",
    draftAlt,
    pageStart: req.body.pageStart ? parseInt(req.body.pageStart, 10) : null,
    pageEnd: req.body.pageEnd ? parseInt(req.body.pageEnd, 10) : null,
  };
  const pattern = req.body.namePattern || "{name}-tagged";

  const sessionId = crypto.randomBytes(12).toString("hex");
  const workDir = path.join(os.tmpdir(), "autotagbot-sess-" + sessionId);
  await fsp.mkdir(workDir, { recursive: true });

  const credentials = new ServicePrincipalCredentials({ clientId, clientSecret });
  const pdfServices = new PDFServices({ credentials });
  const anthropic = draftAlt ? new Anthropic({ apiKey: anthropicKey }) : null;

  // Credentials are held in the session so /api/finalize can re-run the
  // checker on the rewritten PDF without asking the user to re-enter them.
  // Same trust model as before: in-memory only, dropped when the session ends.
  const session = {
    createdAt: Date.now(),
    workDir,
    options,
    files: [],
    credentials: { clientId, clientSecret },
  };
  const errors = [];
  const responseFiles = [];

  try {
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const originalBase = path.parse(file.originalname).name;
      const requested = outputNames[i];
      const outputBase = sanitizeName(
        requested && requested.trim() ? requested.trim() : applyPattern(pattern, originalBase),
        applyPattern(pattern, originalBase),
      );

      const warnings = [];
      let stage = "autotag";
      try {
        const autoTagResult = await withRetry(
          () => runAutotag(pdfServices, file.path, options),
          { label: `autotag ${file.originalname}` },
        );
        const taggedPath = path.join(workDir, `${outputBase}.pdf`);
        await downloadAssetToFile(pdfServices, autoTagResult.taggedPDF, taggedPath);

        let taggingReportPath = null;
        if (options.generateReport && autoTagResult.report) {
          taggingReportPath = path.join(workDir, `${outputBase}-tagging-report.xlsx`);
          await downloadAssetToFile(pdfServices, autoTagResult.report, taggingReportPath);
        }

        // Extract is independent of the rest — if it fails, the file can still
        // be exported as a tagged PDF with no figures surfaced for review.
        let figs = [];
        try {
          stage = "extract";
          const extractDir = path.join(workDir, `extract-${i}`);
          const extractResult = await withRetry(
            () => runExtract(pdfServices, taggedPath),
            { label: `extract ${file.originalname}` },
          );
          const { json: structured } = await unzipExtractResult(pdfServices, extractResult, extractDir);
          figs = collectFigures(structured, extractDir);
        } catch (err) {
          warnings.push({ stage: "extract", message: describeError(err) });
        }

        // Pull any existing /Alt from the tagged PDF so the UI can show what's
        // already there. Order matches the figs[] above (both walk the struct
        // tree in document order). pikepdf missing here is a soft failure —
        // we'll surface a warning and continue without existing-alt info.
        let existingAlts = [];
        try {
          const read = await runPython(READ_ALT_SCRIPT, ["--in", taggedPath]);
          existingAlts = (read && read.alts) || [];
        } catch (err) {
          warnings.push({ stage: "read-existing-alt", message: describeError(err) });
        }

        let drafts = [];
        if (options.draftAlt && anthropic && figs.length) {
          stage = "claude";
          try {
            drafts = await generateAltBatch(anthropic, figs);
          } catch (err) {
            warnings.push({ stage: "claude", message: describeError(err) });
            drafts = figs.map(() => "");
          }
        }

        const figuresResp = [];
        for (let f = 0; f < figs.length; f++) {
          const figureId = `${i}-${f}`;
          const thumbnail = await buildThumbnail(figs[f].renditionPath);
          const existing = existingAlts[f] || {};
          figuresResp.push({
            id: figureId,
            path: figs[f].path,
            page: figs[f].page,
            bbox: figs[f].bbox,
            existingAlt: (existing.alt || "").trim(),
            draftAlt: drafts[f] || "",
            thumbnail,
          });
        }

        session.files.push({
          outputBase,
          originalName: file.originalname,
          taggedPath,
          taggingReportPath,
          figures: figs.map((f, idx) => ({ ...f, id: `${i}-${idx}` })),
        });

        responseFiles.push({
          fileIndex: i,
          originalName: file.originalname,
          outputBase,
          figures: figuresResp,
          warnings,
        });
      } catch (err) {
        errors.push({
          file: file.originalname,
          stage,
          message: describeError(err),
        });
      }
    }

    if (session.files.length === 0) {
      await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
      return res.status(500).json({ error: "All files failed.", errors });
    }

    sessions.set(sessionId, session);
    res.json({ sessionId, files: responseFiles, errors });
  } catch (err) {
    console.error(err);
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    if (!res.headersSent) res.status(500).json({ error: err.message || "Analyze failed." });
  } finally {
    // Clean up the upload temp dirs (we've copied what we need into workDir).
    const uploadDirs = new Set(req.files.map((f) => path.dirname(f.path)));
    for (const dir of uploadDirs) fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function applyAltAndCheck(session, file, altById) {
  const manifest = file.figures.map((f) => ({
    id: f.id,
    path: f.path,
    page: f.page,
    bbox: f.bbox,
    alt: (altById[f.id] && altById[f.id].alt) || "",
    decorative: !!(altById[f.id] && altById[f.id].decorative),
    complex: !!(altById[f.id] && altById[f.id].complex),
  }));

  const manifestPath = path.join(session.workDir, `${file.outputBase}-alt-manifest.json`);
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  let rewrittenPath = null;
  let rewriteReport = null;
  let rewriteError = null;
  try {
    const candidatePath = path.join(session.workDir, `${file.outputBase}-with-alt.pdf`);
    rewriteReport = await runPython(APPLY_ALT_SCRIPT, [
      "--in", file.taggedPath,
      "--out", candidatePath,
      "--manifest", manifestPath,
    ]);
    rewrittenPath = candidatePath;
  } catch (err) {
    rewriteError = err.message || String(err);
  }

  let checkerPdfPath = null;
  let checkerReportPath = null;
  let checkerError = null;
  if (session.options.runAccessibilityChecker) {
    try {
      const credentials = new ServicePrincipalCredentials(session.credentials);
      const pdfServices = new PDFServices({ credentials });
      const checkerResult = await runAccessibilityChecker(
        pdfServices,
        rewrittenPath || file.taggedPath,
        session.options,
      );
      if (checkerResult.asset) {
        checkerPdfPath = path.join(session.workDir, `${file.outputBase}-accessibility.pdf`);
        await downloadAssetToFile(pdfServices, checkerResult.asset, checkerPdfPath);
      }
      if (checkerResult.report) {
        checkerReportPath = path.join(session.workDir, `${file.outputBase}-accessibility-report.json`);
        await downloadAssetToFile(pdfServices, checkerResult.report, checkerReportPath);
      }
    } catch (err) {
      checkerError = err.message || String(err);
    }
  }

  return { manifest, rewrittenPath, rewriteReport, rewriteError, checkerPdfPath, checkerReportPath, checkerError };
}

app.post("/api/finalize", async (req, res) => {
  const { sessionId, altText } = req.body || {};
  if (!sessionId || !sessions.has(sessionId)) return res.status(404).json({ error: "Session not found or expired." });
  const session = sessions.get(sessionId);
  const altById = altText || {};

  // Process each file before opening the zip so a fatal apply_alt failure
  // (e.g. pikepdf missing) returns a clean JSON error instead of a broken stream.
  const perFile = [];
  for (const file of session.files) {
    const result = await applyAltAndCheck(session, file, altById);
    perFile.push({ file, ...result });
  }

  // If every file failed the rewrite, return a 500 with the first error so the
  // user sees the underlying cause instead of a zip with no PDFs in it.
  if (perFile.every((p) => p.rewriteError)) {
    const first = perFile.find((p) => p.rewriteError);
    return res.status(500).json({
      error: "Alt-text write-back failed for every file.",
      detail: first ? first.rewriteError : null,
      hint: "Ensure Python 3 and pikepdf are installed on the server: pip install pikepdf",
    });
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="autotagbot-batch.zip"`);
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => {
    console.error("archive error", err);
    try { res.end(); } catch {}
  });
  archive.pipe(res);

  try {
    for (const p of perFile) {
      const { file, manifest, rewrittenPath, rewriteReport, rewriteError, checkerPdfPath, checkerReportPath, checkerError } = p;

      // Prefer the alt-applied PDF; fall back to the bare tagged PDF if rewrite failed for this file.
      const pdfPath = rewrittenPath || file.taggedPath;
      archive.file(pdfPath, { name: `${file.outputBase}.pdf` });

      if (file.taggingReportPath) {
        archive.file(file.taggingReportPath, { name: `${file.outputBase}-tagging-report.xlsx` });
      }
      if (checkerPdfPath) {
        archive.file(checkerPdfPath, { name: `${file.outputBase}-accessibility.pdf` });
      }
      if (checkerReportPath) {
        archive.file(checkerReportPath, { name: `${file.outputBase}-accessibility-report.json` });
      }

      archive.append(JSON.stringify(manifest, null, 2), { name: `${file.outputBase}-alt-text.json` });

      const csvHeader = "id,path,page,decorative,complex,alt\n";
      const csvBody = manifest
        .map((m) => {
          const alt = (m.alt || "").replace(/"/g, '""');
          const pp = (m.path || "").replace(/"/g, '""');
          return `${m.id},"${pp}",${m.page ?? ""},${m.decorative},${m.complex},"${alt}"`;
        })
        .join("\n");
      archive.append(csvHeader + csvBody + "\n", { name: `${file.outputBase}-alt-text.csv` });

      if (rewriteReport || rewriteError || checkerError) {
        archive.append(
          JSON.stringify(
            { rewrite: rewriteReport || null, rewriteError, checkerError },
            null,
            2,
          ),
          { name: `${file.outputBase}-process-report.json` },
        );
      }
    }

    await archive.finalize();
  } catch (err) {
    console.error(err);
  } finally {
    // Drop credentials and clean up.
    session.credentials = null;
    fsp.rm(session.workDir, { recursive: true, force: true }).catch(() => {});
    sessions.delete(sessionId);
  }
});

app.post("/api/cancel", async (req, res) => {
  const { sessionId } = req.body || {};
  if (sessionId && sessions.has(sessionId)) {
    const s = sessions.get(sessionId);
    await fsp.rm(s.workDir, { recursive: true, force: true }).catch(() => {});
    sessions.delete(sessionId);
  }
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`AutoTagBot listening on http://localhost:${PORT}`);
});
