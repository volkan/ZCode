#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const { engines } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
// 安全补丁下限必须读取仓库声明，避免仅检查主版本而继续放行旧补丁。
const minimum = /^>=(\d+)\.(\d+)\.(\d+)$/u.exec(engines.node);
if (!minimum) throw new Error(`Unsupported engines.node minimum: ${engines.node}`);

const required = minimum.slice(1).map(Number);
const current = process.versions.node.split(".").map(Number);
const firstDifference = required.findIndex((part, index) => part !== current[index]);
const accepted =
  current.length === 3 &&
  current.every(Number.isInteger) &&
  (firstDifference === -1 || current[firstDifference] > required[firstDifference]);

if (!accepted) {
  console.error(`[ci] Node.js ${engines.node} is required, current=${process.versions.node}`);
  process.exit(1);
}

console.log(`[ci] Node.js version OK: ${process.versions.node}`);
