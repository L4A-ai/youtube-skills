# Media preparation recipes

Use these only after `inspect` reports a blocker and the user chooses how the visual composition
should change. The publisher itself never edits source media.

YouTube currently categorizes square or vertical uploads up to 180 seconds as Shorts. H.264 video,
AAC audio, `yuv420p`, and an MP4 container are conservative interoperability choices, not Shorts
classification requirements.

## Preserve everything with padding

This keeps the full landscape frame and adds letterbox space to a 1080x1920 canvas:

```bash
ffmpeg -i input.mp4 \
  -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black" \
  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p \
  -c:a aac -b:a 192k -movflags +faststart output-padded.mp4
```

## Fill the frame by cropping

This fills 9:16 and removes material outside the center crop. Confirm that important subjects,
captions, and logos remain visible:

```bash
ffmpeg -i input.mp4 \
  -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" \
  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p \
  -c:a aac -b:a 192k -movflags +faststart output-cropped.mp4
```

## Trim below the duration edge

Do not rely on rounding a nominal 180-second timeline. A 179.5-second cap leaves a small margin:

```bash
ffmpeg -i input.mp4 -t 179.5 \
  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p \
  -c:a aac -b:a 192k -movflags +faststart output-trimmed.mp4
```

Re-run inspection on the output:

```bash
node scripts/ytshorts.mjs inspect /absolute/path/output-trimmed.mp4
```

Do not overwrite the source unless the user explicitly requests that. Keep third-party music and
other rights constraints in mind; Shorts longer than one minute with an active Content ID claim are
globally blocked while the claim remains active.
