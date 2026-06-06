// The copilot is a reverse-engineering WIZARD COMPANION, not a telemetry
// dashboard (DESIGN.md §7 / §2). Named, decoded value tiles are a POST-discovery
// affordance: they only make sense once a signal has actually been CONFIRMED.
//
// So the copilot ships with an EMPTY project — no placeholder "Speed/RPM/Temp"
// map that pretends the bus is already decoded. Telemetry tiles stay DORMANT
// until real confirmed signals arrive (a future seam: relayed from the cockpit
// Wizard / a shared project / a DBC). Until then the copilot's whole job is the
// Wizard glance + the live page of the cockpit's hunt journal.
//
// Raw bit/byte watching lives in the COCKPIT (the heavy analysis client), never
// on the driver's glanceable phone.

import type { Project } from "../protocol/types";

/** No confirmed signals yet — the telemetry view is dormant by design. */
export const EMPTY_PROJECT: Project = { name: "", frames: [] };
