#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateDemoTranscript } from "./demo.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(root, "docs", "demo-screenshot.svg");

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const { workspace, lines } = await generateDemoTranscript({ redactWorkspace: true });

try {
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  const charWidth = 9.2;
  const lineHeight = 28;
  const width = Math.max(980, Math.ceil(longest * charWidth) + 120);
  const height = lines.length * lineHeight + 140;
  const text = lines
    .map(
      (line, index) =>
        `<text x="54" y="${86 + index * lineHeight}" xml:space="preserve">${escapeXml(line)}</text>`
    )
    .join("\n");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Aethel demo screenshot">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
<stop offset="0%" stop-color="#0b1324"/>
<stop offset="55%" stop-color="#111827"/>
<stop offset="100%" stop-color="#1f2937"/>
</linearGradient>
<linearGradient id="glow" x1="0" y1="0" x2="1" y2="0">
<stop offset="0%" stop-color="#22c55e"/>
<stop offset="50%" stop-color="#38bdf8"/>
<stop offset="100%" stop-color="#f59e0b"/>
</linearGradient>
</defs>
<rect width="${width}" height="${height}" rx="24" fill="url(#bg)"/>
<rect x="22" y="22" width="${width - 44}" height="${height - 44}" rx="18" fill="#0a0f1a" stroke="#243044"/>
<rect x="22" y="22" width="${width - 44}" height="32" rx="18" fill="#10192a"/>
<circle cx="48" cy="38" r="6" fill="#fb7185"/>
<circle cx="68" cy="38" r="6" fill="#f59e0b"/>
<circle cx="88" cy="38" r="6" fill="#22c55e"/>
<rect x="118" y="33" width="${Math.min(280, width - 180)}" height="10" rx="5" fill="url(#glow)" opacity="0.8"/>
<g fill="#dbe4f0" font-family="SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace" font-size="20">
${text}
</g>
</svg>
`;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, svg);
  process.stdout.write(`${outputPath}\n`);
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
