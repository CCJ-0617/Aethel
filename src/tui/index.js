import React from "react";
import { render } from "ink";
import { AethelTui } from "./app.js";

export async function runTui({ drive, includeSharedDrives = false } = {}) {
  const instance = render(
    React.createElement(AethelTui, { drive, includeSharedDrives })
  );
  await instance.waitUntilExit();
}
