import React from "react";
import { render } from "ink";
import { AethelTui } from "./app.js";

export async function runTui({
  drive,
  includeSharedDrives = false,
  cliPath = null,
  cliArgs = [],
} = {}) {
  const instance = render(
    React.createElement(AethelTui, {
      drive,
      includeSharedDrives,
      cliPath,
      cliArgs,
    })
  );
  await instance.waitUntilExit();
}
