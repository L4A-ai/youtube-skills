#!/usr/bin/env node

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workflowsDirectory = fileURLToPath(new URL("../workflows/", import.meta.url));
const workflowFiles = readdirSync(workflowsDirectory)
  .filter((name) => /\.ya?ml$/i.test(name))
  .sort();

assert(workflowFiles.length > 0, "no GitHub Actions workflow files found");

const skillsCommand = /\bskills(?:@[^\s]+)?\s+(?:add|check|list|remove|update)\b/g;
let protectedJobs = 0;
let protectedCommands = 0;

for (const workflowFile of workflowFiles) {
  const source = readFileSync(`${workflowsDirectory}/${workflowFile}`, "utf8");
  const lines = source.split(/\r?\n/);
  const jobsLine = lines.findIndex((line) => line === "jobs:");

  assert(jobsLine >= 0, `${workflowFile}: top-level jobs mapping is missing`);

  for (let index = jobsLine + 1; index < lines.length;) {
    const jobMatch = lines[index].match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (!jobMatch) {
      index += 1;
      continue;
    }

    const jobName = jobMatch[1];
    const start = index;
    index += 1;
    while (index < lines.length && !/^  [A-Za-z0-9_-]+:\s*$/.test(lines[index]) && !/^\S/.test(lines[index])) {
      index += 1;
    }

    const jobLines = lines.slice(start, index);
    const jobSource = jobLines.join("\n");
    const commands = [...jobSource.matchAll(skillsCommand)];
    if (commands.length === 0) continue;

    const envLine = jobLines.findIndex((line) => line === "    env:");
    assert(envLine >= 0, `${workflowFile}:${jobName}: skills CLI commands require job-level env`);

    const envBlock = [];
    for (let envIndex = envLine + 1; envIndex < jobLines.length; envIndex += 1) {
      const line = jobLines[envIndex];
      if (line.trim() && !line.startsWith("      ")) break;
      envBlock.push(line);
    }

    assert(
      envBlock.some((line) => /^      DO_NOT_TRACK:\s*(?:"1"|'1')\s*(?:#.*)?$/.test(line)),
      `${workflowFile}:${jobName}: set job-level DO_NOT_TRACK to the quoted string "1"`,
    );

    protectedJobs += 1;
    protectedCommands += commands.length;
  }
}

assert(protectedCommands > 0, "no internal skills CLI commands found; update this guard if CI no longer installs or lists skills");
console.log(
  `ok: ${protectedCommands} internal skills CLI command(s) in ${protectedJobs} workflow job(s) use job-level DO_NOT_TRACK=\"1\"`,
);
