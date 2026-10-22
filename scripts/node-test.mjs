#!/usr/bin/env node
// Node 20+ test runner: CI cancels remaining files on the first real failure.
import { run } from "node:test";
import { spec } from "node:test/reporters";
import { resolve } from "node:path";

const files = process.argv.slice(2).map(file => resolve(file));
if (!files.length) throw new Error("Pass at least one test file");
const controller = new AbortController();
const tests = run({ files, concurrency: process.env.CI ? 1 : true, signal: controller.signal });
tests.on("test:fail", event => {
  if (event.todo) return;
  process.exitCode = 1;
  if (process.env.CI && !controller.signal.aborted) controller.abort();
});
tests.compose(spec).pipe(process.stdout);
