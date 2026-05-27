const express = require("express");
const multer = require("multer");
const archiver = require("archiver");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { PassThrough } = require("stream");

const {
  ServicePrincipalCredentials,
  PDFServices,
  MimeType,
  AutotagPDFJob,
  AutotagPDFParams,
  AutotagPDFResult,
  PDFAccessibilityCheckerJob,
  PDFAccessibilityCheckerParams,
  PDFAccessibilityCheckerResult,
} = require("@adobe/pdfservices-node-sdk");

const PORT = process.env.PORT || 3000;
const MAX_FILE_BYTES = 100 * 1024 * 1024;

const app = express();
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

async function processOne({ pdfServices, inputPath, outputBase, workDir, options }) {
  const outputs = [];
  const readStream = fs.createReadStream(inputPath);
  const inputAsset = await pdfServices.upload({ readStream, mimeType: MimeType.PDF });

  // Auto-Tag
  const autoTagParams = new AutotagPDFParams({
    shiftHeadings: !!options.shiftHeadings,
    generateReport: !!options.generateReport,
  });
  const autoTagJob = new AutotagPDFJob({ inputAsset, params: autoTagParams });
  const autoTagPollingURL = await pdfServices.submit({ job: autoTagJob });
  const autoTagResponse = await pdfServices.getJobResult({
    pollingURL: autoTagPollingURL,
    resultType: AutotagPDFResult,
  });

  const taggedAsset = autoTagResponse.result.taggedPDF;
  const taggedStream = await pdfServices.getContent({ asset: taggedAsset });
  const taggedPath = path.join(workDir, `${outputBase}.pdf`);
  await streamToFile(taggedStream.readStream, taggedPath);
  outputs.push({ path: taggedPath, name: `${outputBase}.pdf` });

  if (options.generateReport && autoTagResponse.result.report) {
    const reportStream = await pdfServices.getContent({ asset: autoTagResponse.result.report });
    const reportPath = path.join(workDir, `${outputBase}-tagging-report.xlsx`);
    await streamToFile(reportStream.readStream, reportPath);
    outputs.push({ path: reportPath, name: `${outputBase}-tagging-report.xlsx` });
  }

  // Accessibility Checker on tagged PDF
  if (options.runAccessibilityChecker) {
    const checkerInput = await pdfServices.upload({
      readStream: fs.createReadStream(taggedPath),
      mimeType: MimeType.PDF,
    });
    const checkerParamsCfg = {};
    if (options.pageStart) checkerParamsCfg.pageStart = options.pageStart;
    if (options.pageEnd) checkerParamsCfg.pageEnd = options.pageEnd;
    const checkerParams = new PDFAccessibilityCheckerParams(checkerParamsCfg);
    const checkerJob = new PDFAccessibilityCheckerJob({ inputAsset: checkerInput, params: checkerParams });
    const checkerPollingURL = await pdfServices.submit({ job: checkerJob });
    const checkerResponse = await pdfServices.getJobResult({
      pollingURL: checkerPollingURL,
      resultType: PDFAccessibilityCheckerResult,
    });

    const checkerPdfStream = await pdfServices.getContent({ asset: checkerResponse.result.asset });
    const checkerPdfPath = path.join(workDir, `${outputBase}-accessibility.pdf`);
    await streamToFile(checkerPdfStream.readStream, checkerPdfPath);
    outputs.push({ path: checkerPdfPath, name: `${outputBase}-accessibility.pdf` });

    if (checkerResponse.result.report) {
      const checkerReportStream = await pdfServices.getContent({ asset: checkerResponse.result.report });
      const checkerReportPath = path.join(workDir, `${outputBase}-accessibility-report.json`);
      await streamToFile(checkerReportStream.readStream, checkerReportPath);
      outputs.push({ path: checkerReportPath, name: `${outputBase}-accessibility-report.json` });
    }
  }

  return outputs;
}

app.post("/api/batch", upload.array("files"), async (req, res) => {
  const clientId = req.body.clientId;
  const clientSecret = req.body.clientSecret;
  if (!clientId || !clientSecret) {
    return res.status(400).json({ error: "Missing client_id or client_secret." });
  }
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "No PDF files uploaded." });
  }

  let outputNames;
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

  const workDir = path.join(os.tmpdir(), "autotagbot-out-" + crypto.randomBytes(6).toString("hex"));
  await fsp.mkdir(workDir, { recursive: true });

  // Credentials live in this scope only — never written, never logged.
  const credentials = new ServicePrincipalCredentials({ clientId, clientSecret });
  const pdfServices = new PDFServices({ credentials });

  const errors = [];
  const allOutputs = [];

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
        const fileOutputs = await processOne({
          pdfServices,
          inputPath: file.path,
          outputBase,
          workDir,
          options,
        });
        allOutputs.push(...fileOutputs);
      } catch (err) {
        errors.push({ file: file.originalname, message: err.message || String(err) });
      }
    }

    if (allOutputs.length === 0) {
      return res.status(500).json({ error: "All files failed.", errors });
    }

    // Write errors file if any
    if (errors.length) {
      const errorsPath = path.join(workDir, "errors.json");
      await fsp.writeFile(errorsPath, JSON.stringify(errors, null, 2));
      allOutputs.push({ path: errorsPath, name: "errors.json" });
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="autotagbot-batch.zip"`);
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      console.error("archive error", err);
      try { res.end(); } catch {}
    });
    archive.pipe(res);
    for (const out of allOutputs) {
      archive.file(out.path, { name: out.name });
    }
    await archive.finalize();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || "Batch failed." });
    }
  } finally {
    // Best-effort cleanup of uploads + outputs.
    const cleanups = [workDir, ...new Set(req.files.map((f) => path.dirname(f.path)))];
    for (const dir of cleanups) {
      fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
});

app.listen(PORT, () => {
  console.log(`AutoTagBot listening on http://localhost:${PORT}`);
});
