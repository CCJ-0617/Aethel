#!/usr/bin/env node

const cmd = process.argv[2];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function printAuth() {
  console.log("OAuth initialization completed.");
  console.log("Credentials path: /Users/demo/.config/aethel/credentials.json");
  console.log("Token path: /Users/demo/.config/aethel/token.json");
  console.log("Authenticated user: Demo User");
  console.log("Authenticated email: demo@example.com");
  console.log("Storage usage: 1.2 GB");
  console.log("Storage limit: 15.0 GB");
}

function printInit() {
  console.log("\nInitialised Aethel workspace at /Users/demo/my-drive");
  console.log("  Created .aethelignore with default patterns");
  console.log("  Syncing entire My Drive");
}

function printPull() {
  console.log("Staged 24 remote item(s). Committing...");
}

function printPullDone() {
  console.log("Commit complete: 24 downloaded, 0 uploaded");
  console.log("\nEverything up to date.");
}

async function run() {
  if (cmd === "auth") {
    await sleep(1500);
    printAuth();
  } else if (cmd === "init") {
    await sleep(400);
    printInit();
  } else if (cmd === "pull") {
    await sleep(2000);
    printPull();
    await sleep(2500);
    printPullDone();
  } else {
    console.log("mock-setup handles: auth, init, pull");
  }
}

run();
