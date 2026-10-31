// SPDX-License-Identifier: GPL-3.0-or-later
// App identity and the markers that tag turns the extension itself injected.

// Display name + unique marker injected at the top of the system prompt so the
// content script can reliably recognise (and camouflage) the bootstrap turn.
export const APP_NAME = "snapgentV3";
export const SYS_MARKER = "⟦ZS-SYS⟧";
// A re-statement of the system prompt mid-session (see withSysResend in
// core/main.js). It carries SYS_MARKER TOO - that is what drives camouflage
// and session detection, and neither should change - plus this second marker,
// purely so the chip can say "Reminder" instead of inheriting the bootstrap's
// "Starting Up". Same content, different label: a re-injection is not a start.
export const RESEND_MARKER = "⟦ZS-RE⟧";
