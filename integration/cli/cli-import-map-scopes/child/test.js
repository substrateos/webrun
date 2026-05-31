import { pApp } from "../parent-scope/app.ts";
import { cApp } from "./child-scope/app.ts";
export default function() {
    if (pApp !== 'parent-a') throw new Error("Parent scope failed: " + pApp);
    if (cApp !== 'child-a') throw new Error("Child scope failed: " + cApp);
    console.log("SCOPES_OK");
}
