# Captions

Import subtitles, generate them from the composition's own audio, edit them as
ordinary layers, and write them back out as `.srt` or `.vtt`.

All five actions live under **Composition ▸ …** and in the command palette:

| Command | What it does |
|---|---|
| Import Captions… | Reads an `.srt` or `.vtt` file into caption layers. |
| Generate Captions from Audio | Transcribes the composition and builds the layers. |
| Export Captions (.srt) | Writes the caption layers back out as SubRip. |
| Export Captions (.vtt) | The same, as WebVTT. |
| Remove All Captions | Clears them, as one undo step. |

---

## A caption is a text layer

There is no caption object, no caption track and no caption renderer. A caption
is an ordinary text layer whose **clip bar is its cue window**, marked with one
hidden prop (`__caption`) so it can be found again.

That is the whole design, and everything follows from it:

- Captions get per-glyph animators, layer styles, 3D, the graph editor and
  motion blur, because they are text layers and text layers have those.
- Re-timing a caption is dragging its bar. Export reads the bars, so the file
  agrees with the picture — nothing stores the original cue times, deliberately,
  because two sources of truth for "when does this show" is exactly how an
  exported `.srt` ends up disagreeing with the render.
- Restyling one caption is restyling a layer. Restyling all of them is selecting
  them all and restyling a layer.

Import and generate both **replace** any captions already there. A second import
over an unremoved first is forty layers of doubled text, which reads as a
rendering bug rather than as the user's own second import.

## Styling

New captions are sized and placed from the **composition**, not from fixed
pixels: cap height is 5% of comp height and the baseline sits a tenth of the
frame off the bottom, clear of the UI chrome every social platform draws there.
The same style therefore reads correctly on a 1080×1920 vertical cut and a 4K
master, which a hardcoded `48px` does on neither.

Long captions are wrapped **in the model**, at ~42 characters over at most two
lines (broadcast practice), rather than being left to the renderer to wrap on
width. That means the line breaks survive an export and are identical on every
machine, whatever fonts are installed.

## Formats

One parser reads both SRT and WebVTT, because every real file blurs at least one
of the differences between them. It handles what actual exporters produce:

- CRLF line endings and a leading BOM
- `.vtt` written with SRT's comma, and `.srt` written with a period
- `MM:SS.mmm` timestamps with no hour field
- WebVTT cue settings trailing the end time (`align:middle line:90%`)
- `NOTE` and `STYLE` blocks
- files with no blank line between cues
- two-line captions, kept as two lines

A cue with no words is dropped; a zero-length cue is given a one-frame floor
rather than having its words discarded. Overlapping cues are trimmed against
each other on the way in — two captions on screen at once is a transcript
artefact that renders as text over text.

## Generating from audio

**Composition ▸ Generate Captions from Audio** mixes the composition down and
sends it for transcription.

It transcribes the **composition**, not a footage file. Layer trims, levels and
mutes are all applied first, so the cues line up with the picture; transcribing
the source file of a clip that appears at 00:42, trimmed, would produce captions
timed to the file instead. If a work area is set, only that range is transcribed
and the cues are re-based onto composition time.

The audio is prepared as **16 kHz mono** — six times smaller than an export
mixdown, which is the difference between "transcribe this" and "the provider
refuses anything over 25 MB". At that rate the cap is about 13 minutes; set a
work area over a longer piece and run it in passes.

**Provider:** OpenAI, via the key in Settings ▸ Assistant. The call is made from
the Electron main process, so the key never enters the renderer — the same
custody as image generation (`electron/aiProxy.ts`). Anthropic has no audio API,
and Gemini returns prose without timings, which cannot become captions; a
request naming either says so rather than failing obscurely. The command is
disabled, not hidden, where the shell cannot transcribe at all.

There is no hosted transcription route, so this is a local-edition feature
today.

## Source map

| File | What it owns |
|---|---|
| [`captionFormat.ts`](../src/core/captions/captionFormat.ts) | SRT/VTT parsing and writing, wrapping, de-overlapping. Pure. |
| [`captionLayers.ts`](../src/core/captions/captionLayers.ts) | Cues ↔ text layers, and the clip-bar timing. |
| [`speechAudio.ts`](../src/core/captions/speechAudio.ts) | The composition mixed down to 16 kHz mono. |
| [`transcribe.ts`](../src/core/captions/transcribe.ts) | The provider call and the time re-basing. |
| [`captionCommands.ts`](../src/core/captions/captionCommands.ts) | The five commands. |
| [`electron/aiProxy.ts`](../electron/aiProxy.ts) | `ai:transcribe` — the key-holding side. |
