import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const targetDir = process.argv[2] || path.resolve(process.cwd(), "test_fixtures");

if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

console.log(`Generating test fixtures in: ${targetDir}`);

// 1. A 320x240 solid PNG
const pngSolidPath = path.join(targetDir, "solid_green_320x240.png");
execFileSync("ffmpeg", [
  "-y",
  "-f", "lavfi",
  "-i", "color=c=green:s=320x240:d=1",
  "-vframes", "1",
  pngSolidPath,
], { stdio: "ignore" });

// 2. A 320x240 PNG with alpha
const pngAlphaPath = path.join(targetDir, "alpha_transparent_320x240.png");
execFileSync("ffmpeg", [
  "-y",
  "-f", "lavfi",
  "-i", "color=c=red@0.5:s=320x240:d=1",
  "-vframes", "1",
  "-pix_fmt", "rgba",
  pngAlphaPath,
], { stdio: "ignore" });

// 3. Four-second 320x240 30 fps silent H.264 MP4 (2s red, 2s blue)
const mp4CutPath = path.join(targetDir, "two_color_cut_4s.mp4");
execFileSync("ffmpeg", [
  "-y",
  "-f", "lavfi",
  "-i", "color=c=red:s=320x240:r=30:d=2",
  "-f", "lavfi",
  "-i", "color=c=blue:s=320x240:r=30:d=2",
  "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
  "-map", "[v]",
  "-c:v", "libx264",
  "-pix_fmt", "yuv420p",
  mp4CutPath,
], { stdio: "ignore" });

// 4. Valid MKV using FFV1 to exercise proxy playback
const mkvFfv1Path = path.join(targetDir, "ffv1_proxy_exercise.mkv");
execFileSync("ffmpeg", [
  "-y",
  "-f", "lavfi",
  "-i", "color=c=yellow:s=320x240:d=3",
  "-c:v", "ffv1",
  "-level", "3",
  mkvFfv1Path,
], { stdio: "ignore" });

// 5. Corrupt .mp4 containing plain text
const corruptMp4Path = path.join(targetDir, "corrupted_media.mp4");
fs.writeFileSync(corruptMp4Path, "This file is deliberately plain text and corrupt, not valid MP4.");

// 6. Filename with spaces and Unicode
const unicodePath = path.join(targetDir, "JKC 🎬 Sample Take 🎨.mp4");
execFileSync("ffmpeg", [
  "-y",
  "-f", "lavfi",
  "-i", "color=c=purple:s=320x240:r=30:d=2",
  "-c:v", "libx264",
  "-pix_fmt", "yuv420p",
  unicodePath,
], { stdio: "ignore" });

console.log("Fixtures created successfully:");
for (const file of fs.readdirSync(targetDir)) {
  const stat = fs.statSync(path.join(targetDir, file));
  console.log(` - ${file} (${stat.size} bytes)`);
}
