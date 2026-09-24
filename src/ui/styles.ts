export const MODAL_CSS = `
:host { all: initial; }
.backdrop {
  --bg: #ffffff; --fg: #15151a; --muted: #62626e; --line: #e4e4ea; --accent: #ff8a1f; --accent-fg: #1b0f00;
  --error: #c62828; --panel: #f6f6f9;
  position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center; justify-content: center;
  padding: 16px; background: rgba(10, 10, 14, 0.55); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--fg); box-sizing: border-box;
}
@media (prefers-color-scheme: dark) {
  .backdrop { --bg: #17171c; --fg: #f1f1f4; --muted: #a0a0ad; --line: #2c2c35; --panel: #202028; --error: #ff6b6b; }
}
*, *::before, *::after { box-sizing: inherit; }
.dialog {
  width: min(420px, 100%); max-height: calc(100vh - 32px); overflow: auto; background: var(--bg);
  border-radius: 16px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35); padding: 20px;
}
header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
header img { width: 28px; height: 28px; }
h2 { font-size: 17px; font-weight: 650; margin: 0; flex: 1; }
.close { border: 0; background: none; color: var(--muted); font-size: 22px; line-height: 1; cursor: pointer; padding: 4px 8px; border-radius: 8px; }
.close:hover { background: var(--panel); }
p { margin: 0 0 12px; color: var(--muted); }
dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0 0 14px; padding: 10px 12px; background: var(--panel); border-radius: 10px; font-size: 13px; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.stage { display: flex; flex-direction: column; align-items: center; gap: 10px; }
canvas.qr { width: min(340px, 100%); aspect-ratio: 1; image-rendering: pixelated; background: #fff; border-radius: 10px; }
.video-wrap { position: relative; width: 100%; aspect-ratio: 4 / 3; background: #000; border-radius: 12px; overflow: hidden; }
video { width: 100%; height: 100%; object-fit: cover; }
video.mirrored { transform: scaleX(-1); }
.frame-guide { position: absolute; inset: 12%; border: 2px solid rgba(255, 255, 255, 0.7); border-radius: 14px; pointer-events: none; }
.progress { width: 100%; height: 6px; background: var(--line); border-radius: 3px; overflow: hidden; }
.progress > div { height: 100%; width: 0; background: var(--accent); transition: width 0.2s; }
.status { font-size: 13px; color: var(--muted); min-height: 1.45em; text-align: center; }
.error { color: var(--error); font-size: 13px; min-height: 1.45em; text-align: center; }
.actions { display: flex; gap: 8px; margin-top: 14px; }
button.primary, button.secondary { flex: 1; border-radius: 10px; padding: 10px 14px; font: inherit; font-weight: 600; cursor: pointer; }
button.primary { border: 0; background: var(--accent); color: var(--accent-fg); }
button.secondary { border: 1px solid var(--line); background: transparent; color: var(--fg); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
details { width: 100%; font-size: 13px; color: var(--muted); }
summary { cursor: pointer; }
textarea { width: 100%; margin-top: 6px; min-height: 64px; font: 12px ui-monospace, monospace; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--fg); padding: 8px; }
[hidden] { display: none !important; }
`;
