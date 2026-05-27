---
title: AutoTagBot
emoji: 📄
colorFrom: orange
colorTo: red
sdk: docker
app_port: 7860
pinned: false
license: mit
short_description: Batch-process PDFs through Adobe Auto-Tag with Claude alt-text drafts
---

# AutoTagBot

Batch web UI for running PDFs through Adobe's Auto-Tag + Accessibility Checker APIs,
optionally drafting alt text with Claude, reviewing/editing each suggestion, and
writing the final alt text back into the PDF tag tree.

## Hosting

Designed for Hugging Face Spaces (`sdk: docker`), but the Dockerfile runs anywhere.
Locally:

```
docker build -t autotagbot .
docker run --rm -p 7860:7860 autotagbot
# open http://localhost:7860
```

Or without Docker:

```
npm install
pip3 install pikepdf
npm start
# open http://localhost:3000
```

## Credentials

Nothing is baked into the image. Each batch asks for:

- Adobe `client_id` and `client_secret` (Document Services).
- Anthropic API key — only when "Draft alt text with Claude" is enabled.

All credentials live in memory for the duration of a single batch and are
dropped when the export zip is delivered.

## Public-Space caveat

If you set the Space to **public**, anyone can submit batches and burn their
own Adobe/Anthropic quotas (the keys are theirs, never yours). The host still
pays for Space CPU time. Use a **private** Space, or add HF OAuth /
authentication, if that's a concern.
