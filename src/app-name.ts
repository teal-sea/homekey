// ─── App name ───────────────────────────────────────────────────────
// Everything the code derives from the name (the heading, the settings key,
// the export's file names and its take.json format tag) comes from here. The
// two static places a module cannot reach, index.html's <title> and
// package.json's "name", are kept in step by src/app-name.test.ts.
//
// Named Homekey on 2026-11-08 (the working name before it collided with a
// Native Instruments product). Nothing had been released, so the rename loses
// nobody's stored settings.

/** What the page calls itself. */
export const APP_NAME = 'Homekey'

/** The same name for machines: the settings key, file names, take.json's format tag. */
export const APP_SLUG = 'homekey'
