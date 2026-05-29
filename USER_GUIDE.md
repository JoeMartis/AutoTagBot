# AutoTagBot — User Guide

A batch tool for running PDFs through Adobe's Auto-Tag and Accessibility
Checker APIs, with optional Claude-drafted alt text and an in-browser review
step before the final PDF is exported.

---

## 1. What you'll need

| Credential | Where to get it | When it's needed |
|---|---|---|
| Adobe `client_id` | Adobe Developer Console → your PDF Services project → Credentials | Every batch |
| Adobe `client_secret` | Same place | Every batch |
| Anthropic API key | console.anthropic.com → API Keys | Only if you turn on "Draft alt text with Claude" |

The app never stores any of these. They live in server memory only for the
duration of a single batch and are dropped when you export, cancel, or after
1 hour of inactivity.

---

## 2. The flow at a glance

```
   ┌─ Submit ──────────┐       ┌─ Review ────────────┐       ┌─ Export ───────┐
   │ • Paste creds      │       │ • See each figure    │       │ • Apply alt text│
   │ • Pick PDFs        │  ───▶ │ • Edit Claude drafts │  ───▶ │   via pikepdf   │
   │ • Choose options   │       │   or existing alt    │       │ • Re-run checker│
   │ • Click Analyze    │       │ • Click Apply        │       │ • Download zip  │
   └────────────────────┘       └──────────────────────┘       └─────────────────┘
```

---

## 3. Step 1 — Submit

### Credentials
Paste your Adobe `client_id` and `client_secret`. If you want Claude to draft
alt text for you, expand the **Draft alt text with Claude** card and paste an
Anthropic API key. Leave it collapsed if you'd rather write all alt text
yourself — the reviewer still shows each figure with a thumbnail.

### Options
| Option | Effect |
|---|---|
| **Include Accessibility Checker report** | Runs Adobe's WCAG checker on each PDF after alt text is applied. Adds an `*-accessibility.pdf` (with the report embedded) and an `*-accessibility-report.json` to the export. |
| **Generate XLSX tagging report** | Adobe's Auto-Tag emits an Excel report describing which tags it created and which it changed. Adds `*-tagging-report.xlsx`. |
| **Shift headings (WCAG-friendly)** | If Auto-Tag detects a title, marks it `H1` and demotes every other heading by one level so the hierarchy starts at `H1`. Match HTML semantics. |
| **Checker page start / end** | Limits the accessibility check to a page range. Leave both blank to check the whole document. |

### Files & naming
Drag PDFs onto the dashed box (or click it). For each file you can:
- Set a per-file output name in the **Output name** column, or
- Leave it blank and let the **batch name pattern** apply (default
  `{name}-tagged`, where `{name}` is the original filename without extension).

Click **Analyze**. The first stage runs Auto-Tag, Extract, and (if enabled)
Claude. Expect roughly 30–60s per PDF with Claude on, 15–30s without.

---

## 4. Step 2 — Review

The review screen lists every PDF with its figures. For each figure you'll see:

- **Thumbnail** — rendition extracted by Adobe. "No preview" appears for
  vector graphics or other figures Adobe couldn't rasterize; you can still
  edit alt text against the page-number hint.
- **Alt-text textarea** — pre-filled with:
  - the **existing alt** from the PDF (if the source already had one — shown
    with a small "EXISTING ALT FROM PDF" label), otherwise
  - Claude's draft (if drafting was on), otherwise
  - blank for you to fill in.
- **"Claude suggests:"** panel — appears when there's an existing alt *and*
  Claude offered something different. Click **Use this** to swap in Claude's
  version.
- **Decorative** — tick to mark the image as purely decorative; alt text is
  written as empty in the final PDF (most screen readers skip empty alt
  figures). The textarea disables when this is on.
- **Complex** — flag this for images that need a long description (charts,
  diagrams, dense infographics). The flag is recorded in the manifest but
  *not* written to the PDF — you'd add the long description as visible body
  text near the figure in Acrobat.
- **Tag-tree path** — small monospaced string like `//Document/Sect[2]/Figure`.
  Useful for cross-referencing in Acrobat's Tags pane.

Yellow banners appear if anything went wrong on this file (Claude failed for
some figures, Extract was unavailable, figure-count mismatch, etc.). The
batch still proceeds with whatever did succeed.

When you're happy, click **Apply alt & export zip**.

---

## 5. Step 3 — Export

Behind the scenes:
1. Your edits are sent to the server.
2. A Python sidecar (`pikepdf`) walks each tagged PDF's structure tree and
   writes your alt text into the `/Alt` entry of every `/Figure` element.
3. If the Accessibility Checker option was on, it re-runs against the
   alt-updated PDF so the report reflects the final state.
4. The whole thing is bundled into one `autotagbot-batch.zip`.

For each input PDF, the zip contains:

| File | When | What |
|---|---|---|
| `{outputName}.pdf` | always | **The deliverable — tagged + alt text applied.** |
| `{outputName}-alt-text.json` | always | Manifest of what alt text was written, with figure paths and flags. |
| `{outputName}-alt-text.csv` | always | Same data as a spreadsheet (UTF-8 BOM, fully quoted). |
| `{outputName}-tagging-report.xlsx` | if option on | Adobe's Auto-Tag tagging report. |
| `{outputName}-accessibility.pdf` | if option on | PDF with the checker report embedded. View in Acrobat. |
| `{outputName}-accessibility-report.json` | if option on | Same checker results as JSON. |
| `{outputName}-process-report.json` | only if something noteworthy happened | Pikepdf write-back stats, errors, count mismatches. |

To verify alt text landed correctly, open the final PDF in Acrobat:
**View → Show/Hide → Navigation Panes → Tags**, expand the tree, and your
text should appear next to each `<Figure>`.

---

## 5b. Splitting the workflow (session packages)

If you have credentials and a collaborator doesn't, you can do the API-heavy
half and hand off the review.

**You (with keys):**
1. Run **Analyze** as normal — Auto-Tag, Extract, optional Claude drafts.
2. On the review screen, click **Export session package**. You get
   `autotagbot-session.zip`.
3. Hand the zip to your collaborator (email, drive, Slack, whatever).

**Your collaborator (no keys):**
1. On the upload screen, click the **Import session package** tab.
2. Drop the `.zip` in.
3. The review screen opens exactly as if they'd run Analyze themselves —
   thumbnails, draft alt, decorative/complex flags, everything.
4. They edit, click **Apply alt & export zip**, and get the finished PDFs
   with alt text baked in.

The pikepdf write-back doesn't need any API keys, so the import flow works
fully offline. What's lost: the Adobe Accessibility Checker re-run (skipped
on imported sessions — your collaborator can verify alt text by opening the
final PDF's tag tree in Acrobat instead).

---

## 6. Tips and gotchas

- **Decorative is best-effort.** The empty `/Alt` we write satisfies most
  downstream tools but strict PDF/UA checkers (PAC 2024, veraPDF) may still
  flag the figure because the proper fix is to convert the structure element
  to `/Artifact`. That step needs to happen in Acrobat for now.
- **"No preview" figures** typically mean the figure is a vector graphic.
  You can still write alt text — open the PDF on the side and look at the
  page number to find the right image.
- **Existing alt is preserved by default.** If the source PDF already has
  alt on a figure, that's what loads in the textarea and what gets written
  back unless you change it.
- **Claude is optional and per-batch.** Toggle it off if a batch is mostly
  decorative images or you're working with a template you know well.
- **Large batches** — Adobe charges per document operation. Five PDFs with
  ten figures each costs about $0.05 in Adobe credits + about $0.02 in
  Claude tokens (Haiku 4.5).

---

## 7. Common errors

| Symptom | Cause / fix |
|---|---|
| **"Missing Adobe credentials"** | client_id and/or client_secret empty. Paste both. |
| **"Anthropic API key required when 'draft alt text' is on"** | Either paste a key or untick the Claude toggle. |
| **"Alt-text write-back failed for every file"** with hint to install pikepdf | Python 3 and `pikepdf` aren't on the server. `pip3 install pikepdf` (or use the Docker image, which bundles it). |
| **Yellow banner "figure-count-mismatch"** on a file | Adobe and pikepdf disagree on how many figures the PDF has. The existing-alt column may be off; double-check a few figures before exporting. |
| **Zip download fails / connection error** | Adobe API was probably slow and timed out. Try again; if it persists, check the server terminal for the underlying error. |
| **"Session not found or expired"** | The batch sat for >1 hour between Analyze and Apply, or the server restarted. Re-upload and try again. |

---

## 8. Running locally

```sh
git clone https://github.com/JoeMartis/AutoTagBot.git
cd AutoTagBot
npm install
pip3 install pikepdf       # one-time
npm start
# open http://localhost:3000
```

## 9. Running on Hugging Face Spaces

The repo is set up for HF's Docker SDK. Create a Docker Space, add it as a
git remote, and push the branch to `main`:

```sh
git remote add hf https://huggingface.co/spaces/<you>/autotagbot
git push hf claude/gallant-cerf-ZHm0M:main --force
```

The Dockerfile installs Node, Python, and pikepdf and serves on port 7860.
Set the Space to **Private** unless you specifically want a public tool —
public Spaces let anyone burn your Space's CPU time (they bring their own
Adobe / Anthropic keys).
