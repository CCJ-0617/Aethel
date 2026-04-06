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
  const charWidth = 12.4;
  const lineHeight = 32;
  const width = Math.max(1120, Math.ceil(longest * charWidth) + 160);
  const height = lines.length * lineHeight + 168;
  const text = lines
    .map(
      (line, index) =>
        `<text x="64" y="${100 + index * lineHeight}" xml:space="preserve">${escapeXml(line)}</text>`
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
<rect width="${width}" height="${height}" rx="28" fill="url(#bg)"/>
<rect x="24" y="24" width="${width - 48}" height="${height - 48}" rx="20" fill="#0a0f1a" stroke="#243044"/>
<rect x="24" y="24" width="${width - 48}" height="36" rx="20" fill="#10192a"/>
<circle cx="52" cy="42" r="7" fill="#fb7185"/>
<circle cx="74" cy="42" r="7" fill="#f59e0b"/>
<circle cx="96" cy="42" r="7" fill="#22c55e"/>
<rect x="132" y="35" width="${Math.min(320, width - 220)}" height="12" rx="6" fill="url(#glow)" opacity="0.8"/>
<g fill="#dbe4f0" font-family="'Times New Roman', Times, serif" font-size="22">
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
