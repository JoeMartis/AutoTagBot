const express = require("express");
const multer = require("multer");
const archiver = require("archiver");
const AdmZip = require("adm-zip");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

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
    filename: (_req, file, cb) => cb(null, file.originalname),
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
        results[i] = await generateAlt(anthropic, figures[i].renditionPath);
      } catch (err) {
        results[i] = `[draft failed: ${err.message || err}]`;
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

app.post("/api/analyze", upload.array("files"), async (req, res) => {
  const clientId = req.body.clientId;
  const clientSecret = req.body.clientSecret;
  const anthropicKey = req.body.anthropicKey;
  if (!clientId || !clientSecret) return res.status(400).json({ error: "Missing Adobe credentials." });
  if (!anthropicKey) return res.status(400).json({ error: "Missing Anthropic API key." });
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
    pageStart: req.body.pageStart ? parseInt(req.body.pageStart, 10) : null,
    pageEnd: req.body.pageEnd ? parseInt(req.body.pageEnd, 10) : null,
  };
  const pattern = req.body.namePattern || "{name}-tagged";

  const sessionId = crypto.randomBytes(12).toString("hex");
  const workDir = path.join(os.tmpdir(), "autotagbot-sess-" + sessionId);
  await fsp.mkdir(workDir, { recursive: true });

  const credentials = new ServicePrincipalCredentials({ clientId, clientSecret });
  const pdfServices = new PDFServices({ credentials });
  const anthropic = new Anthropic({ apiKey: anthropicKey });

  const session = { createdAt: Date.now(), workDir, options, files: [] };
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

      try {
        const autoTagResult = await runAutotag(pdfServices, file.path, options);
        const taggedPath = path.join(workDir, `${outputBase}.pdf`);
        await downloadAssetToFile(pdfServices, autoTagResult.taggedPDF, taggedPath);

        let taggingReportPath = null;
        if (options.generateReport && autoTagResult.report) {
          taggingReportPath = path.join(workDir, `${outputBase}-tagging-report.xlsx`);
          await downloadAssetToFile(pdfServices, autoTagResult.report, taggingReportPath);
        }

        const extractDir = path.join(workDir, `extract-${i}`);
        const extractResult = await runExtract(pdfServices, taggedPath);
        const { json: structured } = await unzipExtractResult(pdfServices, extractResult, extractDir);
        const figs = collectFigures(structured, extractDir);

        const drafts = figs.length ? await generateAltBatch(anthropic, figs) : [];
        const figuresResp = [];
        for (let f = 0; f < figs.length; f++) {
          const figureId = `${i}-${f}`;
          const thumbnail = await buildThumbnail(figs[f].renditionPath);
          figuresResp.push({
            id: figureId,
            path: figs[f].path,
            page: figs[f].page,
            bbox: figs[f].bbox,
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
        });
      } catch (err) {
        errors.push({ file: file.originalname, message: err.message || String(err) });
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

app.post("/api/finalize", async (req, res) => {
  const { sessionId, altText } = req.body || {};
  if (!sessionId || !sessions.has(sessionId)) return res.status(404).json({ error: "Session not found or expired." });
  const session = sessions.get(sessionId);
  const altById = altText || {};

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="autotagbot-batch.zip"`);
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => {
    console.error("archive error", err);
    try { res.end(); } catch {}
  });
  archive.pipe(res);

  try {
    for (const file of session.files) {
      archive.file(file.taggedPath, { name: `${file.outputBase}.pdf` });
      if (file.taggingReportPath) {
        archive.file(file.taggingReportPath, { name: `${file.outputBase}-tagging-report.xlsx` });
      }

      const manifest = file.figures.map((f) => ({
        id: f.id,
        path: f.path,
        page: f.page,
        bbox: f.bbox,
        alt: (altById[f.id] && altById[f.id].alt) || "",
        decorative: !!(altById[f.id] && altById[f.id].decorative),
        complex: !!(altById[f.id] && altById[f.id].complex),
      }));

      archive.append(JSON.stringify(manifest, null, 2), { name: `${file.outputBase}-alt-text.json` });

      const csvHeader = "id,path,page,decorative,complex,alt\n";
      const csvBody = manifest
        .map((m) => {
          const alt = (m.alt || "").replace(/"/g, '""');
          const p = (m.path || "").replace(/"/g, '""');
          return `${m.id},"${p}",${m.page ?? ""},${m.decorative},${m.complex},"${alt}"`;
        })
        .join("\n");
      archive.append(csvHeader + csvBody + "\n", { name: `${file.outputBase}-alt-text.csv` });
    }

    await archive.finalize();
  } catch (err) {
    console.error(err);
  } finally {
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
