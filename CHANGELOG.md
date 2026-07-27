# Changelog

All notable changes to Chatick are listed here, newest first.

The version at the top must always match `version` in `package.json` — the build
refuses to run otherwise, so a release can never ship without a description.

Written in English only: this file is published on the website.

## 0.2.0 — 2026-07-28

### Added

- Keyboard shortcuts for everyday actions — create a task, document or resource,
  jump to files, tasks or the time tracker, move focus between chat and AI.
  Press `?` anywhere for the cheat sheet, or remap them on the shortcuts page.
- System notifications on the desktop and on the web, with a single place to
  decide whether they appear at all, whether they make a sound, and whether they
  stay quiet while the app is already in front of you.
- A notifications page that keeps the full history. Until now a notification
  disappeared for good once it was read.
- Sharing for files, documents, notes, resources and single messages — either a
  private link for people who already have access, or a public read-only link
  that works without signing in and can be revoked at any time.
- A preview page for shared files: images, video, audio and PDF play in place
  instead of forcing a download.
- "About" with a feedback form, reachable from the profile menu and the tray.

### Changed

- Notifications arrive the moment they happen instead of up to thirty seconds
  later, and now reach you anywhere in the app rather than only inside the
  project they came from.
- Durations are typed the way a clock reads them: `2:30` and `230` both mean two
  and a half hours, `45` means forty-five minutes.
- Files, documents, notes and resources show a handle when you hover them, so
  it is clear they can be dragged into the chat.
- Originals of optimised images are no longer stored, which leaves far more of
  a project's storage for actual work.

- Windows installer, with the shell updating itself in the background and
  applying the update on exit. The interface itself already updates on every
  launch, since it is loaded from the web.

### Fixed

- Notifications never appeared in the browser at all, and on Windows they were
  dropped silently by the system.
- Clicking a system notification opened the right place but left the
  notification unread in the bell and the tray.
- The rich text editor showed raw HTML instead of formatted text.
- Filters on the overview were applied but invisible, so a filtered page looked
  like an empty one.

## 0.1.0 — 2026-06-01

### Added

- First working version: chat with an AI dispatcher, tasks, time tracking,
  documents, notes, files and resources in a single workspace.
- Google sign-in, projects, companies and per-project roles.
- Desktop application for Windows and macOS with a tray panel.
