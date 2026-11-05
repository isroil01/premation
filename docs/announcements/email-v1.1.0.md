# Premation 1.1.0: release email

For **Admin ▸ Email ▸ Templates ▸ Release notes** (`release.notes`, dark theme).
Paste each value into the variable with the same name. The template ends with the
Download button and the changelog link.

## Subject and preheader

- **Subject:** Premation 1.1 is out: cut anything out of your footage
  (the template's default, `Premation {{version}} is out`, also works)
- **Preheader (`summary`):** see below. It also shows as the lead paragraph.

Other subject lines to A/B:
- Text behind people, Photoshop layers, 2× faster playback: Premation 1.1
- The biggest Premation update since 1.0

## Variables

| Variable | Value |
|---|---|
| `version` | 1.1.0 |
| `headline` | Click a person. Put your title behind them. |
| `summary` | Premation 1.1 brings Object Matte, Photoshop and Illustrator import, a bigger Render Queue and playback about twice as fast on heavy compositions. It's our biggest update since 1.0. |
| `heroImage` | https://premation.com/images/email/premation-1.1-hero.jpg (1200×1200: "MOVE" behind a leaping dancer) |
| `highlight1Title` | Object Matte: cut anything out |
| `highlight1Text` | Click a person or object and Premation separates it, hair included, then tracks it through the shot. Put text **behind** it, blur or replace the background, or fill the hole it leaves using frames where the background shows. |
| `highlight1Image` | https://premation.com/images/email/premation-1.1-portrait.jpg (1080×1350: "Golden" behind his curls) |
| `highlight2Title` | Bring in Photoshop, Illustrator and PDF files |
| `highlight2Text` | A PSD opens as a composition of its layers, ready to animate. Illustrator and PDF files come in as sharp vector footage. EXR stays float, ProRes, DNx and MXF are no longer converted to 8-bit, and expressions can read JSON and CSV data. |
| `highlight2Image` | *(leave empty, or a shot of a PSD as layers)* |
| `highlight3Title` | Faster to play, more ways to deliver |
| `highlight3Text` | Frames are built on several cores, so heavy comps play about 2× faster before they're cached, and scrubbing responds instantly. The Render Queue writes several outputs from one render, in DNxHR, HEVC, AV1, TIFF or DPX. Also new: Display P3 and HDR footage, After Effects' 1.0 gamma blending, text background boxes, pose mirroring, and **Help ▸ Report a Problem**. |
| `changelogUrl` | https://premation.com/changelog |

## If you build it as a custom template instead

The built-in has three highlights and one hero. To show all five showcase
images, duplicate it and add these blocks right after highlight 1 (the gallery
stacks on phones), then the rest after highlight 3, before the button:

```json
[
  { "type": "gallery", "images": [
    { "src": "https://premation.com/images/email/premation-1.1-object-matte-sneaker.jpg", "alt": "FLOAT set behind a white sneaker", "caption": "Any object, one click." },
    { "src": "https://premation.com/images/email/premation-1.1-background-blur.jpg", "alt": "A sprinter sharp in front of a blurred stadium", "caption": "Background blurred, subject sharp." }
  ] },
  { "type": "image", "src": "https://premation.com/images/email/premation-1.1-still-life.jpg", "alt": "Amber set behind a perfume bottle", "inset": true, "caption": "Stills and products cut out as cleanly as people." }
]
```

```json
[
  { "type": "divider" },
  { "type": "keyValue", "rows": [
    { "label": "Render Queue", "value": "Several outputs per render · DNxHR, HEVC, AV1 · TIFF and DPX" },
    { "label": "Colour", "value": "Display P3 working space · HDR and camera-log footage" },
    { "label": "Animation", "value": "Keyframeable text background · copy, paste and mirror poses" },
    { "label": "Plugins", "value": "Custom Effect Controls · panels dock as tabs" }
  ] },
  { "type": "callout", "tone": "info", "text": "Already on Premation? Open **Help ▸ Check for Updates** and you'll get 1.1 in place." }
]
```

## Plain-text version

```
Premation 1.1 is out

Click a person. Put your title behind them.

Premation 1.1 brings Object Matte, Photoshop and Illustrator import, a bigger
Render Queue and playback about twice as fast on heavy compositions. It's our
biggest update since 1.0.

OBJECT MATTE: CUT ANYTHING OUT
Click a person or object and Premation separates it, hair included, then
tracks it through the shot. Put text behind it, blur or replace the background,
or fill the hole it leaves.

PHOTOSHOP, ILLUSTRATOR AND PDF
A PSD opens as a composition of its layers. Illustrator and PDF files come in
as vector footage. EXR stays float, and ProRes, DNx and MXF are no longer
converted to 8-bit.

FASTER TO PLAY, MORE WAYS TO DELIVER
Heavy comps play about 2x faster before they're cached, and scrubbing responds
instantly. The Render Queue writes several outputs from one render, in DNxHR,
HEVC, AV1, TIFF or DPX.

Download 1.1: https://premation.com/download
Already installed? Help > Check for Updates.
Everything that changed: https://premation.com/changelog
```

## Images

Five showcase images, all edited in Premation 1.1 (Object Matte, Behind
Subject, Portrait Blur, type and layout) in the project "Premation 1.1 Email
Showcase", one composition each:

| File | Size | What it shows |
|---|---|---|
| `premation-1.1-hero.jpg` | 1200×1200 | "MOVE" behind a leaping dancer |
| `premation-1.1-portrait.jpg` | 1080×1350 | "Golden" behind a man's curls |
| `premation-1.1-object-matte-sneaker.jpg` | 1200×800 | "FLOAT" behind a sneaker |
| `premation-1.1-background-blur.jpg` | 1200×800 | "FAST" behind a sprinter, stadium blurred |
| `premation-1.1-still-life.jpg` | 1080×1350 | "Amber" behind a perfume bottle |

The source photos are AI-generated (Figma image AI, file "Premation 1.1 email
plates"), with originals in `~/Videos/Premation 1.1 email/plates`. The editing
is Premation's. The generator drew swoosh-like marks on the sprinter's shoes;
they're painted out in Premation (layers "Logo patch"). The images live in
motion-landing `public/images/email/`, so the URLs work once that's deployed.

## Before sending

- Send yourself a test from the studio and check it in Gmail on a phone.
- The installers aren't signed. If the download page doesn't explain macOS
  Open Anyway and Windows Run anyway, add a muted text line about it.
- The free provider tiers allow about 600 sends a day in total. For a bigger
  list, check the studio's "remaining today" before you start.
